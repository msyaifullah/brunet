/**
 * Collection Sidebar View for Brunet plugin.
 *
 * An Obsidian ItemView that shows all .bru files in the vault grouped by folder.
 */

import { ItemView, WorkspaceLeaf, TFile } from "obsidian";
import { parseBruFile, getMethodColor } from "./bruParser";
import { parseBruYml, isBrunoYml, isFolderYml } from "./bruYmlParser";
import { runBruRequest } from "./bruRunner";

export const COLLECTION_VIEW_TYPE = "brunet-collection";

export class CollectionView extends ItemView {
  private styleInjected = false;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return COLLECTION_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Brunet Collections";
  }

  getIcon(): string {
    return "network";
  }

  async onOpen(): Promise<void> {
    this.refresh();
    this.registerEvent(this.app.vault.on("create", () => this.refresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.refresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.refresh()));
  }

  async onClose(): Promise<void> {
    // cleanup handled by Obsidian
  }

  refresh(): void {
    const contentArea = this.containerEl.children[1] as HTMLElement;
    contentArea.empty();

    this.injectStyles(contentArea);

    const allFiles = this.app.vault.getFiles();
    const bruFiles = allFiles.filter(f => {
      if (f.extension === "bru") return true;
      if (f.extension === "yml" || f.extension === "yaml") {
        // Include only Bruno YAML request files, not folder manifests
        // We check synchronously by extension first; content check happens in renderFileRow
        return true;
      }
      return false;
    });

    if (bruFiles.length === 0) {
      contentArea.createEl("p", {
        text: "No .bru or Bruno .yml files found in vault.",
        cls: "brunet-col-empty",
      });
      return;
    }

    // Group by folder path
    const groups = new Map<string, TFile[]>();
    for (const file of bruFiles) {
      const folderPath = file.parent?.path ?? "/";
      if (!groups.has(folderPath)) {
        groups.set(folderPath, []);
      }
      groups.get(folderPath)!.push(file);
    }

    // Sort collections alphabetically
    const sortedPaths = Array.from(groups.keys()).sort((a, b) =>
      a.localeCompare(b)
    );

    const container = contentArea.createDiv({ cls: "brunet-col-container" });

    for (const folderPath of sortedPaths) {
      const files = groups.get(folderPath)!;
      files.sort((a, b) => a.basename.localeCompare(b.basename));

      this.renderCollection(container, folderPath, files);
    }
  }

  private renderCollection(
    parent: HTMLElement,
    folderPath: string,
    files: TFile[]
  ): void {
    const collectionEl = parent.createDiv({ cls: "brunet-col-group" });

    const header = collectionEl.createDiv({ cls: "brunet-col-header" });

    const folderName =
      folderPath === "/" || folderPath === ""
        ? "(root)"
        : folderPath.split("/").pop() ?? folderPath;

    header.createEl("span", { text: "▼", cls: "brunet-col-chevron" });
    header.createEl("span", { text: folderName, cls: "brunet-col-folder-name" });
    header.createEl("span", {
      text: String(files.length),
      cls: "brunet-col-badge",
    });

    const fileList = collectionEl.createDiv({ cls: "brunet-col-files" });
    // Start expanded
    fileList.style.display = "block";

    header.addEventListener("click", () => {
      const isOpen = fileList.style.display !== "none";
      fileList.style.display = isOpen ? "none" : "block";
      const chevron = header.querySelector(".brunet-col-chevron") as HTMLElement;
      if (chevron) {
        chevron.textContent = isOpen ? "▶" : "▼";
      }
    });

    for (const file of files) {
      this.renderFileRow(fileList, file);
    }
  }

  private renderFileRow(parent: HTMLElement, file: TFile): void {
    const row = parent.createDiv({ cls: "brunet-col-file-row" });

    // Method badge — read from file name or use placeholder (will update after parse)
    const methodBadge = row.createEl("span", {
      text: "···",
      cls: "brunet-col-method-badge",
    });

    row.createEl("span", { text: file.basename, cls: "brunet-col-file-name" });

    const runBtn = row.createEl("button", {
      text: "▶",
      cls: "brunet-col-run-btn",
    });

    const isYml = file.extension === "yml" || file.extension === "yaml";

    // Load method badge and filter out folder.yml files asynchronously
    this.app.vault.cachedRead(file).then(content => {
      if (isYml) {
        if (!isBrunoYml(content) || isFolderYml(content)) {
          row.remove(); // not a Bruno request file
          return;
        }
        const parsed = parseBruYml(content);
        const method = parsed.request.method || "?";
        methodBadge.textContent = method;
        methodBadge.style.background = getMethodColor(method);
      } else {
        const parsed = parseBruFile(content);
        const method = parsed.request.method || "?";
        methodBadge.textContent = method;
        methodBadge.style.background = getMethodColor(method);
      }
    }).catch(() => {
      methodBadge.textContent = "?";
    });

    // Open file on row click — both .bru and .yml are registered so openFile routes correctly
    row.addEventListener("click", (e) => {
      if (e.target === runBtn) return;
      this.app.workspace.getLeaf(false).openFile(file);
    });

    // Run request on button click
    runBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      runBtn.disabled = true;
      runBtn.textContent = "…";

      this.app.vault.cachedRead(file).then(content => {
        const parsed = isYml ? parseBruYml(content) : parseBruFile(content);
        return runBruRequest(parsed);
      }).then(({ response: resp }) => {
        const is2xx = resp.status >= 200 && resp.status < 300;
        runBtn.textContent = String(resp.status || "ERR");
        runBtn.classList.add(is2xx ? "brunet-col-run-ok" : "brunet-col-run-err");
        runBtn.disabled = false;
      }).catch(() => {
        runBtn.textContent = "ERR";
        runBtn.classList.add("brunet-col-run-err");
        runBtn.disabled = false;
      });
    });
  }

  private injectStyles(contentArea: HTMLElement): void {
    if (this.styleInjected) return;
    this.styleInjected = true;

    const style = contentArea.createEl("style");
    style.textContent = `
      .brunet-col-container {
        font-family: var(--font-interface);
        color: var(--text-normal);
        padding: 0.5em 0;
      }
      .brunet-col-empty {
        color: var(--text-muted);
        font-style: italic;
        padding: 1em;
        font-size: 0.85em;
      }
      .brunet-col-group {
        margin-bottom: 0.25em;
      }
      .brunet-col-header {
        display: flex;
        align-items: center;
        gap: 0.4em;
        padding: 0.35em 0.75em;
        cursor: pointer;
        user-select: none;
        font-size: 0.83em;
        font-weight: 600;
        color: var(--text-muted);
        background: var(--background-secondary);
        border-bottom: 1px solid var(--background-modifier-border);
      }
      .brunet-col-header:hover {
        background: var(--background-modifier-hover);
      }
      .brunet-col-chevron {
        font-size: 0.65em;
        flex-shrink: 0;
        color: var(--text-muted);
      }
      .brunet-col-folder-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .brunet-col-badge {
        font-size: 0.75em;
        background: var(--background-modifier-border);
        border-radius: 999px;
        padding: 0.1em 0.45em;
        color: var(--text-muted);
        font-weight: 400;
        flex-shrink: 0;
      }
      .brunet-col-files {
        padding: 0.2em 0;
      }
      .brunet-col-file-row {
        display: flex;
        align-items: center;
        gap: 0.4em;
        padding: 0.25em 0.75em 0.25em 1.25em;
        cursor: pointer;
        font-size: 0.82em;
        border-bottom: 1px solid var(--background-modifier-border);
      }
      .brunet-col-file-row:hover {
        background: var(--background-modifier-hover);
      }
      .brunet-col-file-row:hover .brunet-col-run-btn {
        visibility: visible;
      }
      .brunet-col-method-badge {
        font-family: var(--font-monospace);
        font-size: 0.72em;
        font-weight: 700;
        padding: 0.1em 0.35em;
        border-radius: 3px;
        background: #aaa;
        color: #fff;
        flex-shrink: 0;
        letter-spacing: 0.03em;
        min-width: 2.8em;
        text-align: center;
      }
      .brunet-col-file-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-normal);
      }
      .brunet-col-run-btn {
        visibility: hidden;
        flex-shrink: 0;
        background: transparent;
        border: 1px solid var(--interactive-accent);
        color: var(--interactive-accent);
        border-radius: 3px;
        padding: 0.1em 0.4em;
        font-size: 0.75em;
        cursor: pointer;
        line-height: 1.4;
        transition: background 0.12s;
      }
      .brunet-col-run-btn:hover {
        background: var(--interactive-accent);
        color: #fff;
      }
      .brunet-col-run-btn:disabled {
        opacity: 0.6;
        cursor: default;
      }
      .brunet-col-run-ok {
        visibility: visible !important;
        color: #49cc90;
        border-color: #49cc90;
      }
      .brunet-col-run-err {
        visibility: visible !important;
        color: #f93e3e;
        border-color: #f93e3e;
      }
    `;
  }
}
