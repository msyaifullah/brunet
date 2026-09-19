/**
 * obsidian-brunet — Main plugin entry point
 *
 * Registers:
 *  1. A custom FileView (BruFileView) for .bru files
 *  2. A CodeMirror 6 syntax highlighter for .bru files via StreamLanguage
 *  3. Commands and a ribbon icon for "Run Brunet Request"
 */

import {
  Plugin,
  TFile,
  WorkspaceLeaf,
  Notice,
  addIcon,
} from "obsidian";

import { BruFileView, BRU_VIEW_TYPE } from "./bruView";
import { bruStreamLanguage } from "./bruHighlight";
import { CollectionView, COLLECTION_VIEW_TYPE } from "./collectionView";
import { ServiceView, SERVICE_VIEW_TYPE } from "./serviceView";
import { formatBruRunCommand } from "./bruCollection";
import { isBrunoJsonFile } from "./bruJsonParser";
import { BruQuickOpenModal } from "./bruQuickOpen";
import {
  BrunetSettingTab,
  DEFAULT_SETTINGS,
  parseBrunetSettings,
  type BrunetSettings,
} from "./settings";

// ---------------------------------------------------------------------------
// Icon SVG — a simple "B" logo in an API-style hex badge
// ---------------------------------------------------------------------------
const BRUNO_ICON_ID = "brunet-icon";
const BRUNO_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4 4h7a5 5 0 0 1 0 10H4V4z"/>
  <path d="M4 14h8a5 5 0 0 1 0 6H4v-6z"/>
  <circle cx="19" cy="7" r="2"/>
  <circle cx="19" cy="17" r="2"/>
  <line x1="17" y1="7" x2="11" y2="7"/>
  <line x1="17" y1="17" x2="12" y2="17"/>
</svg>`;

export default class BrunetPlugin extends Plugin {
  brunetSettings: BrunetSettings = { ...DEFAULT_SETTINGS, flows: [] };
  private environmentListeners = new Set<() => void>();

  async onload(): Promise<void> {
    await this.loadSettings();
    // Register SVG icon
    addIcon(BRUNO_ICON_ID, BRUNO_ICON_SVG);

    // Register the custom view type for .bru files
    this.registerView(
      BRU_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new BruFileView(leaf, this),
    );

    // Register the collection sidebar view
    this.registerView(
      COLLECTION_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new CollectionView(leaf, this),
    );

    this.registerView(
      SERVICE_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new ServiceView(leaf, this),
    );

    this.addSettingTab(new BrunetSettingTab(this.app, this));

    // Tell Obsidian to open .bru and Bruno YAML files with our custom view
    this.registerExtensions(["bru", "yml", "yaml"], BRU_VIEW_TYPE);

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!(file instanceof TFile) || !isBrunoJsonFile(file)) return;
        const leaf = this.app.workspace.getMostRecentLeaf();
        if (!leaf) return;
        void leaf.setViewState({
          type: BRU_VIEW_TYPE,
          state: { file: file.path },
        });
      }),
    );

    // Register the CodeMirror 6 language extension so that
    // .bru files opened in the editor get syntax highlighting
    this.registerEditorExtension(bruStreamLanguage.extension);

    // Ribbon icon
    this.addRibbonIcon("dog", "Search Bruno endpoints", () => {
      new BruQuickOpenModal(this.app).open();
    });

    // Commands
    this.addCommand({
      id: "search-endpoints",
      name: "Search Bruno endpoints",
      callback: () => {
        new BruQuickOpenModal(this.app).open();
      },
    });

    this.addCommand({
      id: "open-bru-preview",
      name: "Open .bru file in preview mode",
      checkCallback: (checking: boolean) => {
        const file = this.getActiveBruFile();
        if (file) {
          if (!checking) {
            void this.openBruPreview(file);
          }
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "copy-run-cli",
      name: "Copy bru run to clipboard",
      checkCallback: (checking: boolean) => {
        const file = this.getActiveBruFile();
        if (file) {
          if (!checking) {
            this.copyRunCommand(file);
          }
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "open-collections",
      name: "Open Collections panel",
      callback: () => {
        void this.openCollectionsPanel();
      },
    });

    this.addCommand({
      id: "open-flow-panel",
      name: "Open flow panel",
      callback: () => {
        void this.openServicePanel();
      },
    });

    this.app.workspace.onLayoutReady(() => {
      void this.openCollectionsPanel();
      void this.openServicePanel();
    });
  }

  onEnvironmentChange(listener: () => void): () => void {
    this.environmentListeners.add(listener);
    return () => this.environmentListeners.delete(listener);
  }

  async setActiveEnvironment(name: string): Promise<void> {
    this.brunetSettings.activeEnvironment = name;
    await this.saveSettings();
    await this.refreshOpenBruViews();
    this.notifyEnvironmentListeners();
  }

  /** Push the new environment into every open Brunet request preview. */
  private async refreshOpenBruViews(): Promise<void> {
    const views = this.app.workspace
      .getLeavesOfType(BRU_VIEW_TYPE)
      .map((leaf) => leaf.view)
      .filter((view): view is BruFileView => view instanceof BruFileView);
    await Promise.all(views.map((view) => view.handleActiveEnvironmentChanged()));
  }

  notifyVarsUpdated(): void {
    this.notifyEnvironmentListeners();
  }

  private notifyEnvironmentListeners(): void {
    for (const listener of this.environmentListeners) {
      listener();
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async openCollectionsPanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(COLLECTION_VIEW_TYPE);
    if (existing.length) {
      void this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeftLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: COLLECTION_VIEW_TYPE, active: true });
    }
  }

  private async openServicePanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(SERVICE_VIEW_TYPE);
    if (existing.length) {
      void this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: SERVICE_VIEW_TYPE, active: true });
    }
  }

  /** Returns the active file if it is a .bru file, otherwise null. */
  private getActiveBruFile(): TFile | null {
    const file = this.app.workspace.getActiveFile();
    if (file && file.extension === "bru") return file;
    return null;
  }

  async loadSettings(): Promise<void> {
    this.brunetSettings = parseBrunetSettings(await this.loadData() as unknown);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.brunetSettings);
  }

  private copyRunCommand(file: TFile): void {
    const cmd = formatBruRunCommand(file.path, this.brunetSettings.activeEnvironment);
    navigator.clipboard.writeText(cmd).then(() => {
      new Notice(`Copied to clipboard:\n${cmd}`);
    }).catch(() => {
      new Notice(`Run command:\n${cmd}`, 8000);
    });
  }

  private async openBruPreview(file: TFile): Promise<void> {
    const { workspace } = this.app;

    // Check if there's already a leaf with this view open for this file
    const existingLeaves = workspace.getLeavesOfType(BRU_VIEW_TYPE);
    for (const leaf of existingLeaves) {
      const view = leaf.view;
      if (view instanceof BruFileView && view.file?.path === file.path) {
        void workspace.revealLeaf(leaf);
        return;
      }
    }

    // Open in a new leaf to the right
    const leaf = workspace.getLeaf("split");
    await leaf.openFile(file, { active: true });
  }
}
