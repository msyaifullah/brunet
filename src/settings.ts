import { App, PluginSettingTab, Setting } from "obsidian";
import type BrunetPlugin from "./main";
import type { Flow } from "./bruFlow";

export interface BrunetSettings {
  activeEnvironment: string;
  flows: Flow[];
}

export const DEFAULT_SETTINGS: BrunetSettings = {
  activeEnvironment: "",
  flows: [],
};

export function parseBrunetSettings(value: unknown): BrunetSettings {
  const next: BrunetSettings = { ...DEFAULT_SETTINGS, flows: [] };
  if (!value || typeof value !== "object") return next;
  const record = value as Record<string, unknown>;
  if (typeof record.activeEnvironment === "string") {
    next.activeEnvironment = record.activeEnvironment;
  }
  if (Array.isArray(record.flows)) {
    next.flows = record.flows.filter(isFlow);
  }
  return next;
}

function isFlow(value: unknown): value is Flow {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.stopOnError === "boolean" &&
    typeof record.mermaid === "string" &&
    Array.isArray(record.steps)
  );
}

export class BrunetSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: BrunetPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Active environment")
      .setDesc(
        "Bruno environment name (file in environments/ without .bru). Prefer the Environment section in the right Brunet sidebar. Leave empty for no environment.",
      )
      .addText((text) =>
        text
          .setPlaceholder("e.g. dev")
          .setValue(this.plugin.brunetSettings.activeEnvironment)
          .onChange(async (value) => {
            await this.plugin.setActiveEnvironment(value.trim());
          }),
      );
  }
}
