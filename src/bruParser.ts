/**
 * Parser for Bruno (.bru) file format.
 *
 * The .bru format uses a custom block-based plain-text structure:
 *   sectionName {
 *     key: value
 *   }
 *
 * Some sections (script:*, body:json, body:text, docs) contain free-form content
 * rather than key:value pairs.
 */

export interface BruMeta {
  name: string;
  type: string;
  seq: number;
}

export interface BruRequest {
  method: string;
  url: string;
  body: string;
  auth: string;
}

export interface BruKeyValue {
  key: string;
  value: string;
  enabled: boolean;
}

export interface BruSection {
  type: "keyvalue" | "freeform";
  entries: BruKeyValue[];
  content: string;
}

export interface BruFile {
  meta: BruMeta;
  request: BruRequest;
  headers: BruKeyValue[];
  query: BruKeyValue[];
  path: BruKeyValue[];
  body: string;
  bodyType: string;
  vars: BruKeyValue[];
  varsPreRequest: BruKeyValue[];
  varsPostResponse: BruKeyValue[];
  scriptPreRequest: string;
  scriptPostResponse: string;
  assertions: BruKeyValue[];
  docs: string;
  raw: string;
}

export const BRU_HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "CONNECT",
  "TRACE",
] as const;

export type BruHttpMethod = (typeof BRU_HTTP_METHODS)[number];

const HTTP_METHODS = new Set<string>(
  BRU_HTTP_METHODS.map((m) => m.toLowerCase()),
);

export function normalizeBruHttpMethod(method: string): BruHttpMethod {
  const upper = (method || "GET").toUpperCase();
  if ((BRU_HTTP_METHODS as readonly string[]).includes(upper)) {
    return upper as BruHttpMethod;
  }
  return "GET";
}

export function isHttpMethodSection(sectionName: string): boolean {
  return HTTP_METHODS.has(sectionName.toLowerCase());
}

/** Payload types supported in `body:* { }` blocks and OpenCollection YAML. */
export const BRU_BODY_TYPES = [
  "json",
  "text",
  "xml",
  "graphql",
  "graphql:vars",
  "form-urlencoded",
  "multipart-form",
] as const;

export type BruBodyType = (typeof BRU_BODY_TYPES)[number];

const FREEFORM_SECTIONS = new Set([
  ...BRU_BODY_TYPES.map((t) => `body:${t}`),
  "script:pre-request",
  "script:post-response",
  "docs",
]);

/** Match `body`, `body:json`, `body:graphql:vars`, etc. */
const BODY_SECTION_HEADER_RE = /^(body(?::[\w:-]+)*)\s*\{$/i;

export function normalizeBruBodyType(bodyType: string): string {
  const t = (bodyType || "").toLowerCase().trim();
  if (t === "graphql-vars") return "graphql:vars";
  if ((BRU_BODY_TYPES as readonly string[]).includes(t)) return t;
  if (t === "none" || !t) return "";
  return t;
}

export function bruBodySectionName(bodyType: string): string {
  const t = normalizeBruBodyType(bodyType);
  return t ? `body:${t}` : "body";
}

export function isFormBodyType(bodyType: string): boolean {
  const t = normalizeBruBodyType(bodyType);
  return t === "form-urlencoded" || t === "multipart-form";
}

export function parseFormBodyContent(content: string): BruKeyValue[] {
  return parseKeyValueLines(content.split("\n"));
}

export function serializeFormBodyContent(entries: BruKeyValue[]): string {
  return entries
    .filter((e) => e.key.trim())
    .map((kv) => {
      const prefix = kv.enabled ? "" : "~";
      if (!kv.value) return `${prefix}${kv.key}`;
      return `${prefix}${kv.key}: ${kv.value}`;
    })
    .join("\n");
}

/** Bruno example/tests blocks — skip when building the live request model. */
const SKIPPED_SECTIONS = new Set(["example", "tests", "test"]);

function parseKeyValueLines(lines: string[]): BruKeyValue[] {
  const result: BruKeyValue[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    let enabled = true;
    let workLine = trimmed;
    if (workLine.startsWith("~")) {
      enabled = false;
      workLine = workLine.slice(1).trim();
    }

    const colonIdx = workLine.indexOf(":");
    if (colonIdx === -1) {
      result.push({ key: workLine, value: "", enabled });
    } else {
      const key = workLine.slice(0, colonIdx).trim();
      const value = workLine.slice(colonIdx + 1).trim();
      result.push({ key, value, enabled });
    }
  }
  return result;
}

export function parseBruFile(content: string): BruFile {
  const result: BruFile = {
    meta: { name: "", type: "", seq: 0 },
    request: { method: "", url: "", body: "none", auth: "none" },
    headers: [],
    query: [],
    path: [],
    body: "",
    bodyType: "",
    vars: [],
    varsPreRequest: [],
    varsPostResponse: [],
    scriptPreRequest: "",
    scriptPostResponse: "",
    assertions: [],
    docs: "",
    raw: content,
  };

  // Split into top-level blocks by matching "sectionName {" ... "}"
  // We iterate line by line and track brace depth
  const lines = content.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Match section header: "sectionName {" (content may continue on the same line)
    const headerMatch = line.match(/^([\w:~-]+)\s*\{/);
    if (headerMatch) {
      const sectionName = headerMatch[1].toLowerCase();

      if (SKIPPED_SECTIONS.has(sectionName)) {
        const { nextLine } = extractBraceBlockContent(lines, i);
        i = nextLine;
        continue;
      }

      if (isBraceDelimitedFreeformSection(sectionName)) {
        const { contentLines, nextLine } = extractBraceBlockContent(lines, i);
        applySectionToResult(result, sectionName, contentLines);
        i = nextLine;
        continue;
      }

      i++;

      // Key/value sections: line-based `{` / `}` depth
      const sectionLines: string[] = [];
      let depth = 1;
      while (i < lines.length && depth > 0) {
        const sl = lines[i];
        const trimSl = sl.trim();
        if (trimSl === "{") depth++;
        else if (trimSl === "}") {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        sectionLines.push(sl);
        i++;
      }

      applySectionToResult(result, sectionName, sectionLines);
      continue;
    }

    i++;
  }

  return result;
}

function applySectionToResult(
  result: BruFile,
  sectionName: string,
  sectionLines: string[],
): void {
  const rawContent = sectionLines.join("\n");

  if (sectionName === "meta") {
    const kvs = parseKeyValueLines(sectionLines);
    for (const kv of kvs) {
      if (kv.key === "name") result.meta.name = kv.value;
      else if (kv.key === "type") result.meta.type = kv.value;
      else if (kv.key === "seq") result.meta.seq = parseInt(kv.value, 10) || 0;
    }
    return;
  }

  if (HTTP_METHODS.has(sectionName)) {
    result.request.method = sectionName.toUpperCase();
    const kvs = parseKeyValueLines(sectionLines);
    for (const kv of kvs) {
      if (kv.key === "url") result.request.url = kv.value;
      else if (kv.key === "body") result.request.body = kv.value;
      else if (kv.key === "auth") result.request.auth = kv.value;
    }
    return;
  }

  if (sectionName === "auth") {
    const kvs = parseKeyValueLines(sectionLines);
    for (const kv of kvs) {
      if (kv.key === "mode" || kv.key === "type") {
        result.request.auth = kv.value;
      }
    }
    return;
  }

  if (sectionName === "headers") {
    result.headers = parseKeyValueLines(sectionLines);
    return;
  }

  if (sectionName === "query" || sectionName === "params:query") {
    result.query = parseKeyValueLines(sectionLines);
    return;
  }

  if (sectionName === "params:path") {
    result.path = parseKeyValueLines(sectionLines);
    return;
  }

  if (sectionName === "assert") {
    result.assertions = parseKeyValueLines(sectionLines);
    return;
  }

  if (sectionName === "vars") {
    result.vars = parseKeyValueLines(sectionLines);
    return;
  }

  if (sectionName === "vars:pre-request") {
    result.varsPreRequest = parseKeyValueLines(sectionLines);
    return;
  }

  if (sectionName === "vars:post-response") {
    result.varsPostResponse = parseKeyValueLines(sectionLines);
    return;
  }

  if (sectionName === "script:pre-request") {
    result.scriptPreRequest = rawContent;
    return;
  }

  if (sectionName === "script:post-response") {
    result.scriptPostResponse = rawContent;
    return;
  }

  if (sectionName === "docs") {
    result.docs = rawContent;
    return;
  }

  if (sectionName.startsWith("body:")) {
    if (result.body.trim()) return;
    const bodyType = sectionName.slice(5).replace(/:+$/, "");
    result.bodyType = bodyType;
    result.body = rawContent;
    syncMethodBodyMode(result);
    return;
  }

  if (sectionName === "body") {
    if (result.body.trim()) return;
    result.body = rawContent;
    return;
  }
}

/** post { body: json } is the body mode — payload lives in body:json { }. */
function syncMethodBodyMode(result: BruFile): void {
  if (result.bodyType) {
    result.request.body = result.bodyType;
  }
}

/** Request payload from body:json / body:text blocks (not post { body: … }). */
export function getBruBodyContent(parsed: BruFile): string {
  return parsed.body;
}

/**
 * Body type from the body:json (etc.) section name.
 * Falls back to post { body: json } mode when no body:* block exists.
 */
export function getBruBodyType(parsed: BruFile): string {
  if (parsed.bodyType) return parsed.bodyType;
  const mode = parsed.request.body.trim().toLowerCase();
  if (mode && mode !== "none") return mode;
  return "";
}

export function isFreeformSection(sectionName: string): boolean {
  return FREEFORM_SECTIONS.has(sectionName.toLowerCase());
}

function isBraceDelimitedFreeformSection(sectionName: string): boolean {
  const name = sectionName.toLowerCase();
  return isFreeformSection(name) || name === "body";
}

/**
 * Extract inner lines of a freeform block (body:json, scripts, etc.).
 * Uses brace-depth with string awareness so JSON/JS `{` `}` does not end the section early.
 */
interface BraceBlockBounds {
  contentLines: string[];
  contentStart: number;
  contentEnd: number;
  nextLine: number;
}

function extractBraceBlockContent(
  lines: string[],
  startLine: number,
): BraceBlockBounds {
  const chunk = lines.slice(startLine).join("\n");
  const braceIdx = chunk.indexOf("{");
  if (braceIdx === -1) {
    return {
      contentLines: [],
      contentStart: startLine + 1,
      contentEnd: startLine + 1,
      nextLine: startLine + 1,
    };
  }

  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  let escape = false;

  for (let pos = braceIdx; pos < chunk.length; pos++) {
    const ch = chunk[pos];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\" && inString !== "`") {
        escape = true;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        const inner = chunk.slice(braceIdx + 1, pos);
        const contentLines = inner.length > 0 ? inner.split("\n") : [];
        const consumedLines = chunk.slice(0, pos + 1).split("\n").length;
        const contentStart =
          startLine + chunk.slice(0, braceIdx + 1).split("\n").length;
        const contentEnd = startLine + consumedLines - 1;
        return {
          contentLines,
          contentStart,
          contentEnd,
          nextLine: startLine + consumedLines,
        };
      }
    }
  }

  const inner = chunk.slice(braceIdx + 1);
  return {
    contentLines: inner.length > 0 ? inner.split("\n") : [],
    contentStart: startLine + chunk.slice(0, braceIdx + 1).split("\n").length,
    contentEnd: lines.length - 1,
    nextLine: lines.length,
  };
}

export function extractBruVars(parsed: BruFile): BruKeyValue[] {
  return dedupeKeyValueEntries([...parsed.vars, ...parsed.varsPreRequest]);
}

/** Environment files: one entry per key (`vars` wins over `vars:pre-request`). */
export function getEnvironmentVarEntries(parsed: BruFile): BruKeyValue[] {
  return dedupeKeyValueEntries([
    ...parsed.varsPreRequest,
    ...parsed.vars,
  ]);
}

export function dedupeKeyValueEntries(entries: BruKeyValue[]): BruKeyValue[] {
  const byKey = new Map<string, BruKeyValue>();
  for (const entry of entries) {
    const key = entry.key.trim();
    if (!key || !entry.enabled) continue;
    byKey.set(key, { key, value: entry.value, enabled: true });
  }
  return Array.from(byKey.values()).sort((a, b) =>
    a.key.localeCompare(b.key),
  );
}

/** Write a minimal environment .bru with a single vars block. */
export function serializeEnvironmentFile(entries: BruKeyValue[]): string {
  const lines = formatKeyValueLines(dedupeKeyValueEntries(entries));
  return `vars {\n${lines.join("\n")}\n}\n`;
}

/** Update or create the `vars` (or `vars:pre-request`) block in a .bru file. */
export function updateBruVarsInFile(raw: string, entries: BruKeyValue[]): string {
  const contentLines = formatKeyValueLines(entries);
  const trimmed = raw.trim();

  if (!trimmed) {
    return `vars {\n${contentLines.join("\n")}\n}\n`;
  }

  const lines = trimmed.split("\n");
  if (findSectionBounds(lines, "vars")) {
    return patchSectionContent(trimmed, "vars", contentLines);
  }
  if (findSectionBounds(lines, "vars:pre-request")) {
    return patchSectionContent(trimmed, "vars:pre-request", contentLines);
  }

  return `${trimmed}\n\nvars {\n${contentLines.join("\n")}\n}\n`;
}

function formatKeyValueLines(entries: BruKeyValue[]): string[] {
  return entries
    .filter((e) => e.key.trim())
    .map((kv) => {
      const prefix = kv.enabled ? "  " : "  ~";
      if (!kv.value) return `${prefix}${kv.key}`;
      return `${prefix}${kv.key}: ${kv.value}`;
    });
}

function formatMethodLines(request: BruRequest): string[] {
  const lines: string[] = [];
  if (request.url) lines.push(`  url: ${request.url}`);
  if (request.body && request.body !== "none") lines.push(`  body: ${request.body}`);
  if (request.auth && request.auth !== "none") lines.push(`  auth: ${request.auth}`);
  return lines;
}

function formatFreeformLines(content: string): string[] {
  if (!content) return [];
  return content.split("\n").map((line) => (line.length ? `  ${line}` : line));
}

type SectionBounds = {
  headerIndex: number;
  contentStart: number;
  contentEnd: number;
};

function resolveQuerySectionName(raw: string): string {
  const lines = raw.split("\n");
  if (findSectionBounds(lines, "params:query")) return "params:query";
  if (findSectionBounds(lines, "query")) return "query";
  return "params:query";
}

function findSectionBounds(lines: string[], sectionName: string): SectionBounds | null {
  const normalized = sectionName.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].trim().match(/^([\w:~-]+)\s*\{$/);
    if (!match || match[1].toLowerCase() !== normalized) continue;

    let depth = 1;
    let j = i + 1;
    const contentStart = j;
    while (j < lines.length && depth > 0) {
      const trimSl = lines[j].trim();
      if (trimSl === "{") depth++;
      else if (trimSl === "}") {
        depth--;
        if (depth === 0) break;
      }
      j++;
    }
    return { headerIndex: i, contentStart, contentEnd: j };
  }
  return null;
}

function findMethodSectionBounds(lines: string[]): (SectionBounds & { sectionName: string }) | null {
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].trim().match(/^([\w:~-]+)\s*\{$/);
    if (!match) continue;

    const sectionName = match[1].toLowerCase();
    if (!HTTP_METHODS.has(sectionName)) continue;

    let depth = 1;
    let j = i + 1;
    const contentStart = j;
    while (j < lines.length && depth > 0) {
      const trimSl = lines[j].trim();
      if (trimSl === "{") depth++;
      else if (trimSl === "}") {
        depth--;
        if (depth === 0) break;
      }
      j++;
    }
    return { headerIndex: i, contentStart, contentEnd: j, sectionName };
  }
  return null;
}

function patchMethodSection(raw: string, request: BruRequest): string {
  const methodLower = normalizeBruHttpMethod(request.method).toLowerCase();
  const contentLines = formatMethodLines(request);
  const lines = raw.split("\n");
  const existing = findMethodSectionBounds(lines);

  if (existing) {
    lines[existing.headerIndex] = `${methodLower} {`;
    const updated = [
      ...lines.slice(0, existing.contentStart),
      ...contentLines,
      ...lines.slice(existing.contentEnd),
    ];
    return updated.join("\n");
  }

  return patchSectionContent(raw, methodLower, contentLines);
}

function patchSectionContent(
  raw: string,
  sectionName: string,
  contentLines: string[],
): string {
  const lines = raw.split("\n");
  const bounds = findSectionBounds(lines, sectionName);

  if (bounds) {
    const updated = [
      ...lines.slice(0, bounds.contentStart),
      ...contentLines,
      ...lines.slice(bounds.contentEnd),
    ];
    return updated.join("\n");
  }

  const block = [sectionName + " {", ...contentLines, "}"];
  const trimmed = raw.trimEnd();
  return trimmed ? `${trimmed}\n\n${block.join("\n")}\n` : `${block.join("\n")}\n`;
}

/**
 * Apply structured edits back into the original .bru text, preserving
 * sections and order that were not modified.
 */
export function serializeBruFile(file: BruFile): string {
  let raw = file.raw;

  if (file.request.method) {
    raw = patchMethodSection(raw, file.request);
  }

  raw = patchSectionContent(raw, "headers", formatKeyValueLines(file.headers));

  raw = patchSectionContent(
    raw,
    resolveQuerySectionName(raw),
    formatKeyValueLines(file.query),
  );

  raw = patchSectionContent(raw, "params:path", formatKeyValueLines(file.path));

  raw = patchBodySection(raw, file.bodyType, file.body);

  return raw;
}

function findRequestBodySectionBounds(lines: string[]): SectionBounds | null {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const headerMatch = line.match(/^([\w:~-]+)\s*\{/);
    if (!headerMatch) {
      i++;
      continue;
    }

    const sectionName = headerMatch[1].toLowerCase();

    if (SKIPPED_SECTIONS.has(sectionName)) {
      i = extractBraceBlockContent(lines, i).nextLine;
      continue;
    }

    const bodyMatch = line.match(BODY_SECTION_HEADER_RE);
    if (bodyMatch && isBraceDelimitedFreeformSection(bodyMatch[1].toLowerCase())) {
      const { contentStart, contentEnd } = extractBraceBlockContent(lines, i);
      return { headerIndex: i, contentStart, contentEnd };
    }

    if (isBraceDelimitedFreeformSection(sectionName)) {
      i = extractBraceBlockContent(lines, i).nextLine;
      continue;
    }

    i++;
    let depth = 1;
    while (i < lines.length && depth > 0) {
      const trimSl = lines[i].trim();
      if (trimSl === "{") depth++;
      else if (trimSl === "}") {
        depth--;
      }
      i++;
    }
  }

  return null;
}

function findBodySectionName(lines: string[]): string | null {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const headerMatch = line.match(/^([\w:~-]+)\s*\{/);
    if (!headerMatch) {
      i++;
      continue;
    }

    const sectionName = headerMatch[1].toLowerCase();

    if (SKIPPED_SECTIONS.has(sectionName)) {
      i = extractBraceBlockContent(lines, i).nextLine;
      continue;
    }

    const bodyMatch = line.match(BODY_SECTION_HEADER_RE);
    if (bodyMatch) return bodyMatch[1].toLowerCase();

    if (isBraceDelimitedFreeformSection(sectionName)) {
      i = extractBraceBlockContent(lines, i).nextLine;
      continue;
    }

    i++;
    let depth = 1;
    while (i < lines.length && depth > 0) {
      const trimSl = lines[i].trim();
      if (trimSl === "{") depth++;
      else if (trimSl === "}") depth--;
      i++;
    }
  }

  return null;
}

function patchBodySection(raw: string, bodyType: string, bodyContent: string): string {
  const sectionName = bruBodySectionName(bodyType);
  const lines = raw.split("\n");
  const existing = findBodySectionName(lines);
  const bounds = findRequestBodySectionBounds(lines);

  if (existing && existing !== sectionName && bounds) {
    lines[bounds.headerIndex] = `${sectionName} {`;
    raw = lines.join("\n");
  }

  const contentLines = formatFreeformLines(bodyContent);
  if (bodyContent.trim() || bodyType || existing) {
    return patchFreeformSectionContent(raw, sectionName, contentLines);
  }

  return raw;
}

function patchFreeformSectionContent(
  raw: string,
  sectionName: string,
  contentLines: string[],
): string {
  const lines = raw.split("\n");
  const bounds = findRequestBodySectionBounds(lines);

  if (bounds) {
    lines[bounds.headerIndex] = `${sectionName} {`;
    const updated = [
      ...lines.slice(0, bounds.contentStart),
      ...contentLines,
      ...lines.slice(bounds.contentEnd),
    ];
    return updated.join("\n");
  }

  const block = [`${sectionName} {`, ...contentLines, "}"];
  const trimmed = raw.trimEnd();
  return trimmed ? `${trimmed}\n\n${block.join("\n")}\n` : `${block.join("\n")}\n`;
}

export function getMethodColor(method: string): string {
  const colors: Record<string, string> = {
    GET: "#61affe",
    POST: "#49cc90",
    PUT: "#fca130",
    PATCH: "#50e3c2",
    DELETE: "#f93e3e",
    HEAD: "#9012fe",
    OPTIONS: "#0d5aa7",
    CONNECT: "#e8c341",
    TRACE: "#e8c341",
  };
  return colors[method.toUpperCase()] ?? "#aaa";
}
