/**
 * Environment tab in the main request view (same kv UI as Headers).
 */

import { TFile, Vault } from "obsidian";
import {
  entriesToVarRecord,
  findCollectionRoot,
  listEnvironmentNames,
  loadEnvironmentVars,
  saveEnvironmentVars,
  type EnvironmentVarsState,
} from "./bruCollection";
import { BruKeyValue, dedupeKeyValueEntries } from "./bruParser";
import { renderEditableKeyValueTable } from "./bruKeyValueEditor";
import type BrunetPlugin from "./main";

export interface EnvironmentTabContext {
  panel: HTMLElement;
  vault: Vault;
  plugin: BrunetPlugin;
  requestFile: TFile;
  /** Pass live env rows while editing; omit after save to reload from disk. */
  onVarsUpdated: (liveEnvVars?: Record<string, string>) => void;
}

export interface EnvironmentTabHandle {
  /** Reload variable rows for the active environment (e.g. after selection changes). */
  refresh: () => Promise<void>;
  /** Current in-memory variable rows (after refresh). */
  getLiveVars: () => Record<string, string>;
}

export async function mountEnvironmentTab(
  ctx: EnvironmentTabContext,
): Promise<EnvironmentTabHandle | null> {
  const { panel, vault, plugin, requestFile, onVarsUpdated } = ctx;
  panel.empty();
  panel.addClass("bru-env-tab-panel");

  const collectionRoot = findCollectionRoot(requestFile, vault);
  if (!collectionRoot) {
    panel.createEl("p", {
      text: "No Bruno collection root (bruno.json or collection.bru).",
      cls: "bru-tab-empty",
    });
    return null;
  }

  const envNames = listEnvironmentNames(vault, collectionRoot);
  if (envNames.length === 0) {
    panel.createEl("p", {
      text: "No environments in environments/.",
      cls: "bru-tab-empty",
    });
    return null;
  }

  const toolbar = panel.createDiv({ cls: "bru-env-tab-toolbar" });
  const typeWrap = toolbar.createDiv({ cls: "bru-body-type-wrap" });
  typeWrap.createSpan({ text: "Environment", cls: "bru-body-type-label" });

  const select = typeWrap.createEl("select", { cls: "bru-body-type-select" });
  select.createEl("option", { text: "(none)", value: "" });
  for (const name of envNames) {
    select.createEl("option", { text: name, value: name });
  }

  const varsHost = panel.createDiv({ cls: "bru-env-tab-vars" });
  let envVarsState: EnvironmentVarsState | null = null;
  let envSaveTimer: number | null = null;
  let liveEntries: BruKeyValue[] = [];

  const syncSelectToSettings = (): void => {
    select.value = plugin.settings.activeEnvironment;
  };

  const pushLiveVarsToRequest = (): void => {
    const envName = plugin.settings.activeEnvironment;
    if (!envName) {
      onVarsUpdated();
      return;
    }
    const live = entriesToVarRecord(liveEntries);
    if (Object.keys(live).length > 0) {
      onVarsUpdated(live);
    } else {
      onVarsUpdated();
    }
  };

  const scheduleSave = () => {
    pushLiveVarsToRequest();
    if (envSaveTimer !== null) window.clearTimeout(envSaveTimer);
    envSaveTimer = window.setTimeout(() => {
      void persistEntries();
      envSaveTimer = null;
    }, 400);
  };

  const persistEntries = async () => {
    const envName = plugin.settings.activeEnvironment;
    if (!envName) return;

    const raw = liveEntries
      .map((e) => ({
        key: e.key.trim(),
        value: e.value,
        enabled: e.enabled,
      }))
      .filter((e) => e.key);
    const deduped = dedupeKeyValueEntries(raw);
    const before = raw.length;

    const file = await saveEnvironmentVars(
      vault,
      collectionRoot,
      envName,
      deduped,
      envVarsState ?? undefined,
    );
    const rawFile = await vault.read(file);
    envVarsState = { file, entries: deduped, raw: rawFile };
    liveEntries = deduped.map((e) => ({ ...e }));
    onVarsUpdated();

    if (deduped.length !== before) {
      await renderVars();
    }
  };

  let renderVarsInflight: Promise<void> | null = null;

  const renderVars = async (): Promise<void> => {
    if (renderVarsInflight) {
      await renderVarsInflight;
      return;
    }

    renderVarsInflight = (async () => {
      syncSelectToSettings();
      varsHost.empty();
      const envName = plugin.settings.activeEnvironment;
      if (!envName) {
        varsHost.createEl("p", {
          text: "Select an environment to edit variables.",
          cls: "bru-tab-empty",
        });
        envVarsState = null;
        liveEntries = [];
        return;
      }

      envVarsState = await loadEnvironmentVars(vault, collectionRoot, envName);
      liveEntries = envVarsState.entries.map((e) => ({ ...e }));

      renderEditableKeyValueTable(varsHost, liveEntries, {
        keyPlaceholder: "Variable name",
        valuePlaceholder: "Variable value",
        addAriaLabel: "Add variable",
        removeLabel: "Remove variable",
        showEnabledColumn: true,
        onChange: scheduleSave,
      });
    })();

    try {
      await renderVarsInflight;
    } finally {
      renderVarsInflight = null;
    }
  };

  select.addEventListener("change", async () => {
    await plugin.setActiveEnvironment(select.value);
  });

  syncSelectToSettings();
  await renderVars();

  return {
    refresh: renderVars,
    getLiveVars: () => entriesToVarRecord(liveEntries),
  };
}
