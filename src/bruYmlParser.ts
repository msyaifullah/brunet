import { parseYaml } from "obsidian";
import { BruFile, BruKeyValue } from "./bruParser";

interface YmlHeader { name: string; value: string }
interface YmlParam  { name: string; value: string; type?: string }
interface YmlBody   { mode?: string; json?: string; text?: string; xml?: string }

interface BrunoYmlDoc {
  info?: { name?: string; type?: string; seq?: number };
  http?: {
    method?: string;
    url?: string;
    headers?: YmlHeader[];
    params?: YmlParam[];
    body?: YmlBody;
    auth?: string;
  };
  settings?: Record<string, unknown>;
}

export function isBrunoYml(content: string): boolean {
  return content.includes("info:") && (content.includes("http:") || content.includes("type: folder"));
}

export function isFolderYml(content: string): boolean {
  try {
    const doc = parseYaml(content) as BrunoYmlDoc;
    return doc?.info?.type === "folder";
  } catch {
    return false;
  }
}

function toKv(arr: YmlHeader[] | undefined): BruKeyValue[] {
  if (!arr) return [];
  return arr
    .filter(h => h.name && h.name.trim() !== "" && h.name.trim() !== '""')
    .map(h => ({ key: h.name, value: String(h.value ?? ""), enabled: true }));
}

function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    const idx = url.indexOf("?");
    return idx === -1 ? url : url.slice(0, idx);
  }
}

export function parseBruYml(content: string): BruFile {
  let doc: BrunoYmlDoc = {};
  try {
    doc = (parseYaml(content) as BrunoYmlDoc) ?? {};
  } catch {
    /* leave empty */
  }

  const info = doc.info ?? {};
  const http = doc.http ?? {};

  const headers = toKv(http.headers);

  const query: BruKeyValue[] = (http.params ?? [])
    .filter(p => (p.type ?? "query") === "query" && p.name && p.name.trim())
    .map(p => ({ key: p.name, value: String(p.value ?? ""), enabled: true }));

  const path: BruKeyValue[] = (http.params ?? [])
    .filter(p => p.type === "path" && p.name && p.name.trim())
    .map(p => ({ key: p.name, value: String(p.value ?? ""), enabled: true }));

  const method = (http.method ?? "GET").toUpperCase();

  // Separate base URL from embedded query string so runner doesn't duplicate params
  const baseUrl = http.url ? stripQuery(http.url) : "";

  let body = "";
  let bodyType = "";
  const b = http.body;
  if (b?.json)  { body = b.json;  bodyType = "json"; }
  else if (b?.text) { body = b.text; bodyType = "text"; }
  else if (b?.xml)  { body = b.xml;  bodyType = "xml"; }

  return {
    meta: {
      name: info.name ?? "",
      type: info.type ?? "http",
      seq: info.seq ?? 0,
    },
    request: {
      method,
      url: baseUrl,
      body: body ? bodyType : "none",
      auth: http.auth ?? "none",
    },
    headers,
    query,
    path,
    body,
    bodyType,
    varsPreRequest: [],
    varsPostResponse: [],
    scriptPreRequest: "",
    scriptPostResponse: "",
    assertions: [],
    docs: "",
    raw: content,
  };
}
