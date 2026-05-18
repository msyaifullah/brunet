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
  body: string;
  bodyType: string;
  varsPreRequest: BruKeyValue[];
  varsPostResponse: BruKeyValue[];
  scriptPreRequest: string;
  scriptPostResponse: string;
  assertions: BruKeyValue[];
  docs: string;
  raw: string;
}

const HTTP_METHODS = new Set([
  "get", "post", "put", "patch", "delete", "head", "options", "connect", "trace",
]);

const FREEFORM_SECTIONS = new Set([
  "body:json",
  "body:text",
  "body:xml",
  "body:graphql",
  "body:graphql:vars",
  "body:form-urlencoded",
  "body:multipart-form",
  "script:pre-request",
  "script:post-response",
  "docs",
]);

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
    body: "",
    bodyType: "",
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

    // Match section header: "sectionName {" or "sectionName:subtype {"
    const headerMatch = line.match(/^([\w:~-]+)\s*\{$/);
    if (headerMatch) {
      const sectionName = headerMatch[1].toLowerCase();
      i++;

      // Collect lines until we find the matching closing brace at depth 0
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

  if (sectionName === "headers") {
    result.headers = parseKeyValueLines(sectionLines);
    return;
  }

  if (sectionName === "query") {
    result.query = parseKeyValueLines(sectionLines);
    return;
  }

  if (sectionName === "assert") {
    result.assertions = parseKeyValueLines(sectionLines);
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
    result.bodyType = sectionName.slice(5);
    result.body = rawContent;
    return;
  }

  if (sectionName === "body") {
    // body without subtype - just store content
    result.body = rawContent;
    return;
  }
}

export function isFreeformSection(sectionName: string): boolean {
  return FREEFORM_SECTIONS.has(sectionName.toLowerCase());
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
