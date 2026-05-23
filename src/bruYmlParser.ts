import { parseYaml, stringifyYaml, TFile } from "obsidian";
import {
  BruFile,
  BruKeyValue,
  isFormBodyType,
  normalizeBruBodyType,
  normalizeBruHttpMethod,
  parseFormBodyContent,
} from "./bruParser";
import { normalizeBodyType } from "./bruBodyEditor";

interface YmlHeader {
  name: string;
  value: string;
  disabled?: boolean;
}

interface YmlParam {
  name: string;
  value: string;
  type?: string;
  disabled?: boolean;
}

interface YmlFormField {
  name: string;
  value: string;
  type?: string;
  disabled?: boolean;
}

interface YmlBody {
  /** OpenCollection YAML (Bruno 3+) */
  type?: string;
  data?: unknown;
  /** Legacy/alternate shapes */
  mode?: string;
  json?: string;
  text?: string;
  xml?: string;
}

interface YmlAuth {
  type?: string;
  token?: string;
  username?: string;
  password?: string;
  [key: string]: unknown;
}

interface YmlParamsBlock {
  query?: YmlParam[];
  path?: YmlParam[];
}

interface BrunoYmlDoc {
  info?: { name?: string; type?: string; seq?: number };
  http?: {
    method?: string;
    url?: string;
    headers?: YmlHeader[];
    params?: YmlParam[] | YmlParamsBlock;
    body?: YmlBody;
    auth?: string | YmlAuth;
  };
  settings?: Record<string, unknown>;
}

export function isBrunoYml(content: string): boolean {
  if (isOpenCollectionYml(content)) return true;
  return (
    content.includes("info:") &&
    (content.includes("http:") ||
      content.includes("type: folder") ||
      content.includes("type: collection"))
  );
}

export interface ManifestYmlInfo {
  name: string;
  type: "folder" | "collection";
  seq: number;
  authType: string;
  openCollectionVersion?: string;
  bundled?: boolean;
  ignore?: string[];
}

export function isOpenCollectionYml(content: string): boolean {
  return /(?:^|\n)opencollection:\s/.test(content);
}

export function isCollectionManifestYmlFile(file: TFile): boolean {
  return (
    (file.basename === "collection" || file.basename === "opencollection") &&
    (file.extension === "yml" || file.extension === "yaml")
  );
}

export function isAnyCollectionManifestYmlFile(file: TFile): boolean {
  return isCollectionManifestYmlFile(file);
}

export function isFolderManifestYmlFile(file: TFile): boolean {
  return (
    file.basename === "folder" &&
    (file.extension === "yml" || file.extension === "yaml")
  );
}

export function parseManifestYml(content: string): ManifestYmlInfo | null {
  try {
    if (isOpenCollectionYml(content)) {
      const doc = parseYaml(content) as {
        opencollection?: string | number;
        info?: { name?: string; seq?: number };
        bundled?: boolean;
        extensions?: { bruno?: { ignore?: string[] } };
      };

      return {
        name: doc.info?.name ?? "",
        type: "collection",
        seq: doc.info?.seq ?? 0,
        authType: "",
        openCollectionVersion: String(doc.opencollection ?? ""),
        bundled: doc.bundled,
        ignore: doc.extensions?.bruno?.ignore ?? [],
      };
    }

    const doc = parseYaml(content) as {
      info?: { name?: string; type?: string; seq?: number };
      request?: { auth?: string | YmlAuth };
      http?: { auth?: string | YmlAuth };
    };
    const manifestType = doc?.info?.type;
    if (manifestType !== "folder" && manifestType !== "collection") {
      return null;
    }

    const authRaw = doc.request?.auth ?? doc.http?.auth;
    let authType = "";
    if (typeof authRaw === "string") {
      authType = authRaw;
    } else if (authRaw?.type) {
      authType = authRaw.type;
    }

    return {
      name: doc.info?.name ?? "",
      type: manifestType,
      seq: doc.info?.seq ?? 0,
      authType,
    };
  } catch {
    return null;
  }
}

export function isFolderYml(content: string): boolean {
  return parseManifestYml(content)?.type === "folder";
}

export function isCollectionYml(content: string): boolean {
  return parseManifestYml(content)?.type === "collection";
}

/** True for HTTP request YAML — not folder/collection manifests. */
export function isRunnableBrunoYml(content: string, file: TFile): boolean {
  if (
    isFolderManifestYmlFile(file) ||
    isCollectionManifestYmlFile(file) ||
    isOpenCollectionYml(content)
  ) {
    return false;
  }
  if (!isBrunoYml(content)) return false;
  const manifest = parseManifestYml(content);
  if (manifest?.type === "folder" || manifest?.type === "collection") {
    return false;
  }
  return Boolean(parseBruYml(content).request.method);
}

function toKv(arr: YmlHeader[] | undefined): BruKeyValue[] {
  if (!arr) return [];
  return arr
    .filter((h) => h.name && h.name.trim() !== "" && h.name.trim() !== '""')
    .map((h) => ({
      key: h.name,
      value: String(h.value ?? ""),
      enabled: h.disabled !== true,
    }));
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

function parseYmlParams(params: YmlParam[] | YmlParamsBlock | undefined): {
  query: BruKeyValue[];
  path: BruKeyValue[];
} {
  if (!params) return { query: [], path: [] };

  if (Array.isArray(params)) {
    return {
      query: params
        .filter((p) => (p.type ?? "query") === "query" && p.name?.trim())
        .map((p) => ({
          key: p.name,
          value: String(p.value ?? ""),
          enabled: p.disabled !== true,
        })),
      path: params
        .filter((p) => p.type === "path" && p.name?.trim())
        .map((p) => ({
          key: p.name,
          value: String(p.value ?? ""),
          enabled: p.disabled !== true,
        })),
    };
  }

  return {
    query: (params.query ?? [])
      .filter((p) => p.name?.trim())
      .map((p) => ({
        key: p.name,
        value: String(p.value ?? ""),
        enabled: p.disabled !== true,
      })),
    path: (params.path ?? [])
      .filter((p) => p.name?.trim())
      .map((p) => ({
        key: p.name,
        value: String(p.value ?? ""),
        enabled: p.disabled !== true,
      })),
  };
}

/** OpenCollection `body.type` + `body.data` and legacy `body.json` shapes. */
export function extractYmlBody(body: YmlBody | undefined): {
  body: string;
  bodyType: string;
} {
  if (!body) return { body: "", bodyType: "" };

  const openType = body.type ?? body.mode;
  if (openType) {
    const bodyType = normalizeBruBodyType(String(openType)) || String(openType).toLowerCase();

    if (body.data === undefined || body.data === null) {
      return { body: "", bodyType };
    }

    if (typeof body.data === "string") {
      return { body: body.data, bodyType };
    }

    if (Array.isArray(body.data)) {
      const lines = body.data
        .filter(
          (field): field is YmlFormField =>
            typeof field === "object" && field !== null && "name" in field,
        )
        .map((field) => {
          const name = field.name;
          const value = String(field.value ?? "");
          const prefix = field.disabled === true ? "~" : "";
          if (!value) return `${prefix}${name}`;
          return `${prefix}${name}: ${value}`;
        });
      return { body: lines.join("\n"), bodyType };
    }

    if (typeof body.data === "object") {
      return {
        body: JSON.stringify(body.data, null, 2),
        bodyType: bodyType === "json" || bodyType === "graphql:vars" ? bodyType : bodyType,
      };
    }
  }

  if (body.json) return { body: body.json, bodyType: "json" };
  if (body.text) return { body: body.text, bodyType: "text" };
  if (body.xml) return { body: body.xml, bodyType: "xml" };

  return { body: "", bodyType: "" };
}

function buildYmlBody(
  bodyType: string,
  bodyContent: string,
  requestBodyMode = "",
): YmlBody | undefined {
  const normalized = normalizeBodyType(bodyType || requestBodyMode || "json");
  const trimmed = bodyContent.trim();
  const mode = normalizeBruBodyType(requestBodyMode);

  if (!trimmed && (!mode || mode === "none")) {
    return undefined;
  }

  if (isFormBodyType(normalized)) {
    const fields = parseFormBodyContent(bodyContent)
      .filter((e) => e.key.trim())
      .map((e) => ({
        name: e.key,
        value: e.value,
        ...(e.enabled ? {} : { disabled: true }),
      }));
    return {
      type: normalized,
      data: fields.length > 0 ? fields : [],
    };
  }

  if (normalized === "graphql:vars" && trimmed.startsWith("{")) {
    try {
      return { type: normalized, data: JSON.parse(trimmed) };
    } catch {
      /* keep as string */
    }
  }

  return { type: normalized, data: bodyContent };
}

function extractYmlAuth(auth: string | YmlAuth | undefined): string {
  if (!auth) return "none";
  if (typeof auth === "string") return auth || "none";
  return auth.type ?? "none";
}

export function updateYmlHeaders(raw: string, entries: BruKeyValue[]): string {
  let doc: BrunoYmlDoc = {};
  try {
    doc = (parseYaml(raw) as BrunoYmlDoc) ?? {};
  } catch {
    return raw;
  }

  const newHeaders: YmlHeader[] = entries
    .filter((e) => e.key.trim() && e.enabled)
    .map((e) => ({ name: e.key, value: e.value }));

  if (!doc.http) doc.http = {};
  doc.http.headers = newHeaders.length > 0 ? newHeaders : undefined;

  return stringifyYaml(doc);
}

export function updateYmlParams(
  raw: string,
  queryEntries: BruKeyValue[],
  pathEntries: BruKeyValue[],
): string {
  let doc: BrunoYmlDoc = {};
  try {
    doc = (parseYaml(raw) as BrunoYmlDoc) ?? {};
  } catch {
    return raw;
  }

  const newQueryParams: YmlParam[] = queryEntries
    .filter((e) => e.key.trim() && e.enabled)
    .map((e) => ({ name: e.key, value: e.value, type: "query" as const }));
  const newPathParams: YmlParam[] = pathEntries
    .filter((e) => e.key.trim() && e.enabled)
    .map((e) => ({ name: e.key, value: e.value, type: "path" as const }));

  const merged = [...newQueryParams, ...newPathParams];
  if (!doc.http) doc.http = {};
  doc.http.params = merged.length > 0 ? merged : undefined;

  return stringifyYaml(doc);
}

export function updateYmlBody(
  raw: string,
  bodyType: string,
  bodyContent: string,
): string {
  let doc: BrunoYmlDoc = {};
  try {
    doc = (parseYaml(raw) as BrunoYmlDoc) ?? {};
  } catch {
    return raw;
  }

  if (!doc.http) doc.http = {};

  const type = normalizeBodyType(bodyType);
  const trimmed = bodyContent.trim();

  if (!trimmed && !type) {
    doc.http.body = undefined;
  } else {
    doc.http.body = buildYmlBody(type, bodyContent, type);
  }

  return stringifyYaml(doc);
}

/** Apply in-memory request edits back to a Bruno YAML file. */
export function updateYmlFromParsed(raw: string, parsed: BruFile): string {
  let doc: BrunoYmlDoc = {};
  try {
    doc = (parseYaml(raw) as BrunoYmlDoc) ?? {};
  } catch {
    return raw;
  }

  if (!doc.http) doc.http = {};

  doc.http.method = normalizeBruHttpMethod(parsed.request.method).toLowerCase();
  doc.http.url = parsed.request.url || "";

  const newHeaders: YmlHeader[] = parsed.headers
    .filter((e) => e.key.trim() && e.enabled)
    .map((e) => ({ name: e.key, value: e.value }));
  doc.http.headers = newHeaders.length > 0 ? newHeaders : undefined;

  const newQueryParams: YmlParam[] = parsed.query
    .filter((e) => e.key.trim() && e.enabled)
    .map((e) => ({ name: e.key, value: e.value, type: "query" as const }));
  const newPathParams: YmlParam[] = parsed.path
    .filter((e) => e.key.trim() && e.enabled)
    .map((e) => ({ name: e.key, value: e.value, type: "path" as const }));
  const merged = [...newQueryParams, ...newPathParams];
  doc.http.params = merged.length > 0 ? merged : undefined;

  doc.http.body = buildYmlBody(
    parsed.bodyType,
    parsed.body,
    parsed.request.body,
  );

  return stringifyYaml(doc);
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
  const { query, path } = parseYmlParams(http.params);

  const method = normalizeBruHttpMethod(http.method ?? "GET");

  // Separate base URL from embedded query string so runner doesn't duplicate params
  const baseUrl = http.url ? stripQuery(http.url) : "";

  const { body, bodyType } = extractYmlBody(http.body);
  const auth = extractYmlAuth(http.auth);

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
      auth,
    },
    headers,
    query,
    path,
    body,
    bodyType,
    vars: [],
    varsPreRequest: [],
    varsPostResponse: [],
    scriptPreRequest: "",
    scriptPostResponse: "",
    assertions: [],
    docs: "",
    raw: content,
  };
}
