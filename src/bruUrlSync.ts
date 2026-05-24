/**
 * Keeps request.url, params:path, and params:query in sync with the URL bar.
 */

import { BruFile, BruKeyValue } from "./bruParser";
import { buildBruRequest } from "./bruRunner";

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
  }
  parsed.request.url = url.slice(0, idx);
}

/** Final URL after path substitution and query params (same as Send uses). */
export function buildDisplayUrl(
  parsed: BruFile,
  collectionVars?: Record<string, string>,
): string {
  return buildBruRequest(parsed, { collectionVars }).url;
}

/** Apply a manual URL bar edit back into structured path/query fields. */
export function applyUrlInputToParsed(parsed: BruFile, fullUrl: string): void {
  if (fullUrl.indexOf("?") === -1) {
    parsed.query = [];
  } else {
    parsed.query = parseQueryFromUrl(fullUrl);
  }

  let base = stripUrlQuery(fullUrl);

  for (const p of parsed.path) {
    if (!p.enabled || !p.key.trim() || !p.value) continue;
    const key = p.key.trim();
    const value = p.value;
    for (const segment of [encodeURIComponent(value), value]) {
      if (!segment || !base.includes(segment)) continue;
      base = base.replace(new RegExp(escapeRegExp(segment), "g"), `:${key}`);
    }
  }

  parsed.request.url = base;
}
