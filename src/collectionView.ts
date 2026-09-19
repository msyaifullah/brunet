/**
 * Collection Sidebar View for Brunet plugin.
 *
 * An Obsidian ItemView that shows all .bru files in the vault grouped by folder.
 */

import { ItemView, WorkspaceLeaf, TFile } from "obsidian";
import { parseBruFile, methodModifierClass } from "./bruParser";
import { parseBruYml, isRunnableBrunoYml } from "./bruYmlParser";
import { runBruRequest } from "./bruRunner";
import {
  isCandidateRequestFile,
  isRunnableBruFile,
  loadCollectionVars,
} from "./bruCollection";
import type BrunetPlugin from "./main";

export const COLLECTION_VIEW_TYPE = "brunet-collection";

export class CollectionView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private plugin: BrunetPlugin,
  ) {
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
    const contentArea = this.contentEl;
    contentArea.empty();

    const allFiles = this.app.vault.getFiles();
    const bruFiles = allFiles.filter(isCandidateRequestFile);

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

    header.createSpan({ text: "▼", cls: "brunet-col-chevron" });
    header.createSpan({ text: folderName, cls: "brunet-col-folder-name" });
    header.createSpan({
      text: String(files.length),
      cls: "brunet-col-badge",
    });

    const fileList = collectionEl.createDiv({ cls: "brunet-col-files" });

    header.addEventListener("click", () => {
      const collapsed = fileList.hasClass("is-collapsed");
      fileList.toggleClass("is-collapsed", !collapsed);
      const chevron = header.querySelector(".brunet-col-chevron");
      if (chevron instanceof HTMLElement) {
        chevron.setText(collapsed ? "▼" : "▶");
      }
    });

    for (const file of files) {
      this.renderFileRow(fileList, file);
    }
  }

  private renderFileRow(parent: HTMLElement, file: TFile): void {
    const row = parent.createDiv({ cls: "brunet-col-file-row" });

    // Method badge — read from file name or use placeholder (will update after parse)
    const methodBadge = row.createSpan({
      text: "···",
      cls: "brunet-col-method-badge",
    });

    row.createSpan({ text: file.basename, cls: "brunet-col-file-name" });

    const runBtn = row.createEl("button", {
      text: "▶",
      cls: "brunet-col-run-btn",
    });

    const isYml = file.extension === "yml" || file.extension === "yaml";

    // Load method badge and filter out folder.yml files asynchronously
    this.app.vault.cachedRead(file).then(content => {
      if (isYml) {
        if (!isRunnableBrunoYml(content, file)) {
          row.remove();
          return;
        }
        const parsed = parseBruYml(content);
        const method = parsed.request.method || "?";
        methodBadge.setText(method);
        methodBadge.addClass(methodModifierClass(method));
      } else {
        const parsed = parseBruFile(content);
        if (!isRunnableBruFile(parsed, file)) {
          row.remove();
          return;
        }
        const method = parsed.request.method || "?";
        methodBadge.setText(method);
        methodBadge.addClass(methodModifierClass(method));
      }
    }).catch(() => {
      methodBadge.setText("?");
    });

    // Open file on row click — both .bru and .yml are registered so openFile routes correctly
    row.addEventListener("click", (e) => {
      if (e.target === runBtn) return;
      void this.app.workspace.getLeaf(false).openFile(file);
    });

    // Run request on button click
    runBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      runBtn.disabled = true;
      runBtn.textContent = "…";

      this.app.vault.cachedRead(file).then(async (content) => {
        const parsed = isYml ? parseBruYml(content) : parseBruFile(content);
        const collectionVars = await loadCollectionVars(
          this.app.vault,
          file,
          this.plugin.brunetSettings.activeEnvironment,
        );
        return runBruRequest(parsed, { collectionVars });
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

}
