/**
 * HTTP Request Runner for Bruno (.bru) files.
 *
 * Uses Obsidian's requestUrl to bypass CORS (runs in Electron context).
 */

import { requestUrl } from "obsidian";
import { BruFile, BruKeyValue } from "./bruParser";

export interface BruResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  json: unknown | null;
  durationMs: number;
  error?: string;
}

function resolveVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (_match, key) => {
    const trimmed = key.trim();
    return trimmed in vars ? vars[trimmed] : `{{${trimmed}}}`;
  });
}

function buildVarsMap(entries: BruKeyValue[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.enabled) {
      vars[entry.key] = entry.value;
    }
  }
  return vars;
}

export function getStatusText(status: number): string {
  const map: Record<number, string> = {
    200: "OK",
    201: "Created",
    204: "No Content",
    301: "Moved Permanently",
    302: "Found",
    304: "Not Modified",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    408: "Request Timeout",
    409: "Conflict",
    422: "Unprocessable Entity",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
  };
  return map[status] ?? `Status ${status}`;
}

export async function runBruRequest(parsed: BruFile): Promise<BruResponse> {
  const vars = buildVarsMap(parsed.varsPreRequest);

  // Build URL with query params
  let rawUrl = resolveVars(parsed.request.url, vars);
  const enabledQuery = parsed.query.filter(q => q.enabled);
  if (enabledQuery.length > 0) {
    const params = new URLSearchParams();
    for (const q of enabledQuery) {
      params.append(resolveVars(q.key, vars), resolveVars(q.value, vars));
    }
    const separator = rawUrl.includes("?") ? "&" : "?";
    rawUrl = rawUrl + separator + params.toString();
  }

  // Build headers
  const headers: Record<string, string> = {};
  for (const h of parsed.headers) {
    if (h.enabled) {
      const key = resolveVars(h.key, vars);
      const value = resolveVars(h.value, vars);
      headers[key] = value;
    }
  }

  // Build body
  const method = parsed.request.method.toUpperCase();
  const noBodyMethods = new Set(["GET", "HEAD"]);
  let bodyStr: string | undefined;
  if (parsed.body.trim() && !noBodyMethods.has(method)) {
    bodyStr = resolveVars(parsed.body.trim(), vars);
  }

  const startMs = Date.now();
  try {
    const resp = await requestUrl({
      url: rawUrl,
      method,
      headers,
      body: bodyStr,
    });

    const durationMs = Date.now() - startMs;

    let jsonResult: unknown | null = null;
    try {
      jsonResult = resp.json;
    } catch {
      jsonResult = null;
    }

    return {
      status: resp.status,
      statusText: getStatusText(resp.status),
      headers: resp.headers as Record<string, string>,
      body: resp.text,
      json: jsonResult,
      durationMs,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - startMs;

    if (
      typeof err === "object" &&
      err !== null &&
      "status" in err
    ) {
      const httpErr = err as { status: number; message?: string; headers?: Record<string, string>; text?: string };
      const status = httpErr.status;

      let body = "";
      let jsonResult: unknown | null = null;
      try {
        body = httpErr.text ?? "";
      } catch {
        body = "";
      }
      try {
        const parsed = JSON.parse(body);
        jsonResult = parsed;
      } catch {
        jsonResult = null;
      }

      return {
        status,
        statusText: getStatusText(status),
        headers: (httpErr.headers as Record<string, string>) ?? {},
        body,
        json: jsonResult,
        durationMs,
        error: `HTTP ${status}: ${getStatusText(status)}`,
      };
    }

    // Network error
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 0,
      statusText: "Network Error",
      headers: {},
      body: "",
      json: null,
      durationMs,
      error: message,
    };
  }
}
