/**
 * Bruno collection layout: collection.bru, folder.bru, and environments/.
 */

import { TFile, Vault } from "obsidian";
import {
  BruFile,
  BruKeyValue,
  extractBruVars,
  getEnvironmentVarEntries,
  parseBruFile,
  serializeEnvironmentFile,
} from "./bruParser";
import { isFolderManifestYmlFile, isAnyCollectionManifestYmlFile } from "./bruYmlParser";
import { isBrunoJsonFile } from "./bruJsonParser";

export function isEnvironmentFile(file: TFile): boolean {
  return file.parent?.name === "environments";
}

export function isCollectionManifestFile(file: TFile): boolean {
  return file.basename === "collection" && file.extension === "bru";
}

export function isFolderManifestFile(file: TFile): boolean {
  return file.basename === "folder" && file.extension === "bru";
}

export function isAnyFolderManifestFile(file: TFile): boolean {
  return isFolderManifestFile(file) || isFolderManifestYmlFile(file);
}

export function isAnyCollectionManifestFile(file: TFile): boolean {
  return (
    isCollectionManifestFile(file) ||
    isAnyCollectionManifestYmlFile(file) ||
    isBrunoJsonFile(file)
  );
}

export function isBruManifest(parsed: BruFile, file: TFile): boolean {
  if (isEnvironmentFile(file) || isAnyCollectionManifestFile(file)) return true;
  if (isFolderManifestFile(file)) return true;
  if (parsed.meta.type === "folder" || parsed.meta.type === "collection") return true;
  return false;
}

export function isRunnableBruFile(parsed: BruFile, file: TFile): boolean {
  if (file.extension !== "bru") return false;
  if (isBruManifest(parsed, file)) return false;
  return Boolean(parsed.request.method);
}

function varsToRecord(entries: BruKeyValue[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.enabled && entry.key.trim()) {
      vars[entry.key] = entry.value;
    }
  }
  return vars;
}

function mergeVarLayers(...layers: Record<string, string>[]): Record<string, string> {
  return Object.assign({}, ...layers);
}

export function findCollectionRoot(file: TFile, vault: Vault): string | null {
  let folder = file.parent;
  while (folder) {
    if (hasCollectionMarker(vault, folder.path)) {
      return folder.path;
    }
    folder = folder.parent;
  }
  return null;
}

function hasCollectionMarker(vault: Vault, folderPath: string): boolean {
  const prefix = folderPath ? `${folderPath}/` : "";
  return (
    vault.getAbstractFileByPath(`${prefix}bruno.json`) instanceof TFile ||
    vault.getAbstractFileByPath(`${prefix}collection.bru`) instanceof TFile
  );
}

export function listEnvironmentNames(vault: Vault, collectionRoot: string): string[] {
  const envFolderPath = collectionRoot
    ? `${collectionRoot}/environments`
    : "environments";

  return vault
    .getFiles()
    .filter(
      (f) =>
        f.extension === "bru" &&
        f.parent?.path === envFolderPath,
    )
    .map((f) => f.basename)
    .sort((a, b) => a.localeCompare(b));
}

function isEnvironmentBruPath(filePath: string): boolean {
  return /(?:^|\/)environments\/[^/]+\.bru$/i.test(filePath);
}

export function getEnvironmentBruPath(
  collectionRoot: string,
  envName: string,
): string {
  const envFolder = collectionRoot ? `${collectionRoot}/environments` : "environments";
  return `${envFolder}/${envName}.bru`;
}

export interface EnvironmentVarsState {
  file: TFile | null;
  entries: BruKeyValue[];
  raw: string;
}

export async function loadEnvironmentVars(
  vault: Vault,
  collectionRoot: string,
  envName: string,
): Promise<EnvironmentVarsState> {
  const path = getEnvironmentBruPath(collectionRoot, envName);
  const file = vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) {
    return { file: null, entries: [], raw: "" };
  }
  const raw = await vault.read(file);
  const parsed = parseBruFile(raw);
  return { file, entries: getEnvironmentVarEntries(parsed), raw };
}

export async function saveEnvironmentVars(
  vault: Vault,
  collectionRoot: string,
  envName: string,
  entries: BruKeyValue[],
  existing?: EnvironmentVarsState,
): Promise<TFile> {
  const path = getEnvironmentBruPath(collectionRoot, envName);
  const content = serializeEnvironmentFile(entries);

  if (existing?.file) {
    await vault.modify(existing.file, content);
    return existing.file;
  }

  const folderPath = collectionRoot
    ? `${collectionRoot}/environments`
    : "environments";
  const folder = vault.getAbstractFileByPath(folderPath);
  if (!folder) {
    await vault.createFolder(folderPath);
  }

  return vault.create(path, content);
}

function ancestorFolderBruPaths(requestFile: TFile, collectionRoot: string): string[] {
  const paths: string[] = [];
  let folder = requestFile.parent;

  while (
    folder &&
    (folder.path === collectionRoot || folder.path.startsWith(`${collectionRoot}/`))
  ) {
    const folderBru = `${folder.path}/folder.bru`;
    paths.push(folderBru);
    if (folder.path === collectionRoot) break;
    folder = folder.parent;
  }

  return paths.reverse();
}

async function readVarsFromPath(
  vault: Vault,
  filePath: string,
): Promise<Record<string, string>> {
  const file = vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) return {};
  try {
    const content = await vault.cachedRead(file);
    const parsed = parseBruFile(content);
    const entries = isEnvironmentBruPath(filePath)
      ? getEnvironmentVarEntries(parsed)
      : extractBruVars(parsed);
    return varsToRecord(entries);
  } catch {
    return {};
  }
}

/**
 * Merge variables Bruno-style: environment → collection → ancestor folders.
 * Request-level vars are applied separately in bruRunner (highest priority).
 */
export async function loadCollectionVars(
  vault: Vault,
  requestFile: TFile,
  environmentName: string,
): Promise<Record<string, string>> {
  const collectionRoot = findCollectionRoot(requestFile, vault);
  if (!collectionRoot) return {};

  const layers: Record<string, string>[] = [];

  if (environmentName) {
    const envPath = getEnvironmentBruPath(collectionRoot, environmentName);
    layers.push(await readVarsFromPath(vault, envPath));
  }

  const collectionPath = collectionRoot
    ? `${collectionRoot}/collection.bru`
    : "collection.bru";
  layers.push(await readVarsFromPath(vault, collectionPath));

  for (const folderBru of ancestorFolderBruPaths(requestFile, collectionRoot)) {
    layers.push(await readVarsFromPath(vault, folderBru));
  }

  return mergeVarLayers(...layers);
}

export function formatBruRunCommand(
  filePath: string,
  environmentName: string,
): string {
  const quoted = `"${filePath}"`;
  if (environmentName) {
    return `bru run ${quoted} --env ${environmentName}`;
  }
  return `bru run ${quoted}`;
}
