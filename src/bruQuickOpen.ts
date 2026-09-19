import { App, FuzzySuggestModal, TFile } from "obsidian";
import type { FuzzyMatch } from "obsidian";
import { methodModifierClass } from "./bruParser";
import { listRunnableRequestFiles, type RunnableRequestFile } from "./bruFlow";
import { BRU_VIEW_TYPE, BruFileView } from "./bruView";

export class BruQuickOpenModal extends FuzzySuggestModal<RunnableRequestFile> {
  private items: RunnableRequestFile[] = [];

  constructor(app: App) {
    super(app);
    this.setPlaceholder("Search Bruno endpoints by name, method, or URL…");
    this.setInstructions([
      { command: "↑↓", purpose: "navigate" },
      { command: "↵", purpose: "open" },
      { command: "esc", purpose: "dismiss" },
    ]);

    void listRunnableRequestFiles(app.vault).then((files) => {
      this.items = files;
      this.inputEl.dispatchEvent(new Event("input"));
    });
  }

  getItems(): RunnableRequestFile[] {
    return this.items;
  }

  getItemText(item: RunnableRequestFile): string {
    return `${item.method} ${item.name} ${item.url} ${item.path}`;
  }

  renderSuggestion(match: FuzzyMatch<RunnableRequestFile>, el: HTMLElement): void {
    const { item } = match;

    const top = el.createDiv({ cls: "bru-qo-top" });
    top.createSpan({
      text: item.method,
      cls: `bru-method-badge bru-qo-badge ${methodModifierClass(item.method)}`,
    });
    top.createSpan({ text: item.name, cls: "bru-qo-name" });

    if (item.url) {
      el.createDiv({ text: item.url, cls: "bru-qo-url" });
    }
    el.createDiv({ text: item.path, cls: "bru-qo-path" });
  }

  onChooseItem(item: RunnableRequestFile): void {
    const file = this.app.vault.getAbstractFileByPath(item.path);
    if (!(file instanceof TFile)) return;

    const { workspace } = this.app;
    const existing = workspace
      .getLeavesOfType(BRU_VIEW_TYPE)
      .find((leaf) => leaf.view instanceof BruFileView && leaf.view.file?.path === item.path);

    if (existing) {
      void workspace.revealLeaf(existing);
    } else {
      const leaf = workspace.getLeaf("tab");
      void leaf.openFile(file);
    }
  }
}
