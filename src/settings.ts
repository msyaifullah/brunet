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

export class BrunetSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: BrunetPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Brunet" });

    new Setting(containerEl)
      .setName("Active environment")
      .setDesc(
        "Bruno environment name (file in environments/ without .bru). Prefer the Environment section in the right Brunet sidebar. Leave empty for no environment.",
      )
      .addText((text) =>
        text
          .setPlaceholder("e.g. dev")
          .setValue(this.plugin.settings.activeEnvironment)
          .onChange(async (value) => {
            await this.plugin.setActiveEnvironment(value.trim());
          }),
      );
  }
}
