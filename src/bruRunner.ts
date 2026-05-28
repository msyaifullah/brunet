/**
 * HTTP Request Runner for Bruno (.bru) files.
 *
 * Uses Obsidian's requestUrl to bypass CORS (runs in Electron context).
 */

import { requestUrl } from "obsidian";
import { BruFile, BruKeyValue, getBruBodyType, isFormBodyType, parseFormBodyContent } from "./bruParser";
import { extractBruVars } from "./bruParser";
import { normalizeBodyType } from "./bruBodyEditor";

export interface BruResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  json: unknown | null;
  durationMs: number;
  error?: string;
}

/** Resolved request sent over the wire (after vars, path, and query). */
export interface BruRequestSnapshot {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface BruRunResult {
  request: BruRequestSnapshot;
  response: BruResponse;
}

export interface BruRunOptions {
  /** Collection, folder, and environment variables (request vars override these). */
  collectionVars?: Record<string, string>;
}

export function resolveVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (_match, key) => {
    const trimmed = key.trim();
    return trimmed in vars ? vars[trimmed] : `{{${trimmed}}}`;
  });
}

/** Best-effort restore `{{name}}` placeholders from resolved literal values. */
export function reverseResolveVars(
  text: string,
  vars: Record<string, string>,
): string {
  let result = text;
  const entries = Object.entries(vars)
    .filter(([, value]) => value.length > 0)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [key, value] of entries) {
    if (result.includes(value)) {
      result = result.split(value).join(`{{${key}}}`);
    }
  }
  return result;
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

/** Merged variable map: collection/env/folder layers plus request-level vars. */
export function buildEffectiveVars(
  parsed: BruFile,
  collectionVars?: Record<string, string>,
): Record<string, string> {
  return {
    ...(collectionVars ?? {}),
    ...buildVarsMap(extractBruVars(parsed)),
  };
}

export function buildBruRequest(
  parsed: BruFile,
  options?: BruRunOptions,
): BruRequestSnapshot {
  const vars = buildEffectiveVars(parsed, options?.collectionVars);

  let rawUrl = resolveVars(parsed.request.url, vars);

  for (const p of parsed.path.filter((e) => e.enabled && e.key.trim())) {
    const key = resolveVars(p.key, vars);
    const value = encodeURIComponent(resolveVars(p.value, vars));
    rawUrl = rawUrl.replace(
      new RegExp(`:${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=/|$|\\?|&)`, "g"),
      value,
    );
  }

  const enabledQuery = parsed.query.filter((q) => q.enabled);
  if (enabledQuery.length > 0) {
    const params = new URLSearchParams();
    for (const q of enabledQuery) {
      params.append(resolveVars(q.key, vars), resolveVars(q.value, vars));
    }
    const separator = rawUrl.includes("?") ? "&" : "?";
    rawUrl = rawUrl + separator + params.toString();
  }

  const headers: Record<string, string> = {};
  for (const h of parsed.headers) {
    if (h.enabled) {
      const key = resolveVars(h.key, vars);
      const value = resolveVars(h.value, vars);
      headers[key] = value;
    }
  }

  const method = parsed.request.method.toUpperCase();
  const noBodyMethods = new Set(["GET", "HEAD"]);
  let bodyStr: string | undefined;
  const bodyType = normalizeBodyType(getBruBodyType(parsed));
  if (parsed.body.trim() && !noBodyMethods.has(method)) {
    if (bodyType === "form-urlencoded") {
      const params = new URLSearchParams();
      for (const e of parseFormBodyContent(parsed.body)) {
        if (e.enabled && e.key.trim()) {
          params.append(
            resolveVars(e.key, vars),
            resolveVars(e.value, vars),
          );
        }
      }
      bodyStr = params.toString();
      const hasContentType = Object.keys(headers).some(
        (k) => k.toLowerCase() === "content-type",
      );
      if (!hasContentType) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
      }
    } else {
      bodyStr = resolveVars(parsed.body.trim(), vars);
    }
  }

  return { method, url: rawUrl, headers, body: bodyStr };
}

export async function runBruRequest(
  parsed: BruFile,
  options?: BruRunOptions,
): Promise<BruRunResult> {
  const request = buildBruRequest(parsed, options);
  const startMs = Date.now();
  try {
    const resp = await requestUrl({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body,
    });

    const durationMs = Date.now() - startMs;

    let jsonResult: unknown | null = null;
    try {
      jsonResult = resp.json;
    } catch {
      jsonResult = null;
    }

    return {
      request,
      response: {
        status: resp.status,
        statusText: getStatusText(resp.status),
        headers: resp.headers as Record<string, string>,
        body: resp.text,
        json: jsonResult,
        durationMs,
      },
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
        request,
        response: {
          status,
          statusText: getStatusText(status),
          headers: (httpErr.headers as Record<string, string>) ?? {},
          body,
          json: jsonResult,
          durationMs,
          error: `HTTP ${status}: ${getStatusText(status)}`,
        },
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    return {
      request,
      response: {
        status: 0,
        statusText: "Network Error",
        headers: {},
        body: "",
        json: null,
        durationMs,
        error: message,
      },
    };
  }
}
