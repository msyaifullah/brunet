import { TFile } from "obsidian";

export interface BrunoJsonManifest {
  name: string;
  version: string;
  type: string;
  ignore: string[];
}

export function isBrunoJsonFile(file: TFile): boolean {
  return file.basename === "bruno" && file.extension === "json";
}

export function parseBrunoJson(content: string): BrunoJsonManifest | null {
  try {
    const doc = JSON.parse(content) as {
      name?: string;
      version?: string | number;
      type?: string;
      ignore?: string[];
    };
    if (!doc || typeof doc !== "object") return null;
    if (doc.type !== "collection" && !doc.name) return null;

    return {
      name: doc.name ?? "",
      version: String(doc.version ?? ""),
      type: doc.type ?? "collection",
      ignore: Array.isArray(doc.ignore) ? doc.ignore.map(String) : [],
    };
  } catch {
    return null;
  }
}
