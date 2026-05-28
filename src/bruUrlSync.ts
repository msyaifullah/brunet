/**
 * Keeps request.url, params:path, and params:query in sync (Bruno / Postman style).
 *
 * - URL bar edits the template (`{{vars}}`, `:pathParams`) without embedded query.
 * - Enabled query params are appended only in the resolved preview / on Send.
 * - `:param` segments in the template auto-populate the Path Parameters table.
 */

import { BruFile, BruKeyValue } from "./bruParser";
import {
  buildBruRequest,
  resolveVars,
  reverseResolveVars,
} from "./bruRunner";

export function stripUrlQuery(url: string): string {
  const idx = url.indexOf("?");
  return idx === -1 ? url : url.slice(0, idx);
}

export function parseQueryFromUrl(url: string): BruKeyValue[] {
  const idx = url.indexOf("?");
  if (idx === -1) return [];

  const result: BruKeyValue[] = [];
  const params = new URLSearchParams(url.slice(idx + 1));
  params.forEach((value, key) => {
    result.push({ key, value, enabled: true });
  });
  return result;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Path placeholder names from a template URL (`:userId`, etc.). */
export function extractPathParamNames(templateUrl: string): string[] {
  const names: string[] = [];
  const re = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(templateUrl)) !== null) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/**
 * Ensure params:path rows exist for every `:name` in the template URL (Bruno-style).
 * Preserves existing values; keeps manual rows not present in the URL at the end.
 */
export function syncPathParamsFromTemplate(parsed: BruFile): void {
  const names = extractPathParamNames(parsed.request.url);
  const byKey = new Map<string, BruKeyValue>();
  for (const p of parsed.path) {
    const k = p.key.trim();
    if (k) byKey.set(k, p);
  }

  const synced: BruKeyValue[] = names.map(
    (name) => byKey.get(name) ?? { key: name, value: "", enabled: true },
  );

  for (const p of parsed.path) {
    const k = p.key.trim();
    if (k && !names.includes(k)) synced.push(p);
  }

  parsed.path = synced;
}

export function renamePathParamInUrl(
  parsed: BruFile,
  oldKey: string,
  newKey: string,
): void {
  const from = oldKey.trim();
  const to = newKey.trim();
  if (!from || !to || from === to) return;
  parsed.request.url = parsed.request.url.replace(
    new RegExp(`:${escapeRegExp(from)}(?=/|$|\\?|&)`, "g"),
    `:${to}`,
  );
}

/**
 * Merge query params parsed from a URL bar paste into params:query.
 * Keys present in the URL are enabled/updated; others stay disabled (Postman-style).
 */
export function mergeQueryParamsFromUrl(
  parsed: BruFile,
  fullUrl: string,
  vars: Record<string, string>,
): void {
  const fromUrl = parseQueryFromUrl(fullUrl).map((q) => ({
    key: reverseResolveVars(q.key, vars),
    value: reverseResolveVars(q.value, vars),
    enabled: true,
  }));
  const urlKeys = new Set(fromUrl.map((q) => q.key));

  const retained = parsed.query
    .filter((q) => q.key.trim() && !urlKeys.has(q.key.trim()))
    .map((q) => ({ ...q, enabled: false }));

  parsed.query = [...fromUrl, ...retained];
}

/**
 * If the method block url embeds a query string, move it into params:query
 * and keep request.url as the path-only base (with :placeholders).
 */
export function normalizeParsedUrl(parsed: BruFile): void {
  const url = parsed.request.url;
  if (!url) return;

  const idx = url.indexOf("?");
  if (idx === -1) return;

  const fromUrl = parseQueryFromUrl(url);
  if (fromUrl.length > 0 && parsed.query.length === 0) {
    parsed.query = fromUrl;
  } else if (fromUrl.length > 0) {
    mergeQueryParamsFromUrl(parsed, url, {});
  }
  parsed.request.url = url.slice(0, idx);
  syncPathParamsFromTemplate(parsed);
}

/** Template URL stored in the .bru file (no query string). */
export function getTemplateUrl(parsed: BruFile): string {
  return parsed.request.url || "";
}

/** Final URL after vars, path substitution, and enabled query params (same as Send). */
export function buildDisplayUrl(
  parsed: BruFile,
  collectionVars?: Record<string, string>,
): string {
  return buildBruRequest(parsed, { collectionVars }).url;
}

/** Whether the resolved URL differs from the template (preview is useful). */
export function hasResolvedUrlPreview(
  parsed: BruFile,
  collectionVars?: Record<string, string>,
): boolean {
  const template = getTemplateUrl(parsed);
  const resolved = buildDisplayUrl(parsed, collectionVars);
  return resolved !== template;
}

/**
 * Apply edits to the URL template field (not the resolved preview).
 * Pasting a full URL with `?query` splits into params:query automatically.
 */
export function applyTemplateUrlToParsed(parsed: BruFile, input: string): void {
  const trimmed = input.trim();
  parsed.request.url = trimmed;

  if (trimmed.includes("?")) {
    normalizeParsedUrl(parsed);
  } else {
    syncPathParamsFromTemplate(parsed);
  }
}

/** Substitute resolved path segment values back to `:placeholders` in a URL string. */
function templateizePathSegments(
  url: string,
  pathEntries: BruKeyValue[],
  vars: Record<string, string>,
): string {
  let base = url;
  for (const p of pathEntries) {
    if (!p.enabled || !p.key.trim() || !p.value.trim()) continue;
    const key = p.key.trim();
    const resolved = resolveVars(p.value, vars);
    for (const segment of [encodeURIComponent(resolved), resolved]) {
      if (!segment || !base.includes(segment)) continue;
      base = base.replace(new RegExp(escapeRegExp(segment), "g"), `:${key}`);
      break;
    }
  }
  return base;
}

/**
 * Apply a resolved URL bar edit (legacy / paste) back into template + params.
 * Reverses environment substitution where possible.
 */
export function applyUrlInputToParsed(
  parsed: BruFile,
  fullUrl: string,
  options?: { vars?: Record<string, string> },
): void {
  const vars = options?.vars ?? {};
  const hasQuery = fullUrl.includes("?");

  if (hasQuery) {
    mergeQueryParamsFromUrl(parsed, fullUrl, vars);
  } else {
    for (const q of parsed.query) {
      if (q.key.trim()) q.enabled = false;
    }
  }

  let base = stripUrlQuery(fullUrl);
  base = reverseResolveVars(base, vars);
  base = templateizePathSegments(base, parsed.path, vars);
  parsed.request.url = base;
  syncPathParamsFromTemplate(parsed);
}
