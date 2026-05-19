/**
 * Custom Obsidian FileView for .bru files.
 *
 * Renders a rich HTML preview of the Bruno request file with:
 *  - Prominent METHOD + URL header
 *  - Tabbed panels for Headers, Body, Params, and More
 *  - Editable URL, headers, and body (saved back to the .bru file)
 *  - A button to copy the `bru run <filename>` command
 */

import { Plugin, TextFileView, WorkspaceLeaf, Notice, TFile, setIcon } from "obsidian";
import {
  parseBruFile,
  serializeBruFile,
  BruFile,
  BruKeyValue,
  getMethodColor,
} from "./bruParser";
import { parseBruYml, isBrunoYml } from "./bruYmlParser";
import { runBruRequest, BruResponse, BruRunResult, BruRequestSnapshot } from "./bruRunner";
import {
  normalizeParsedUrl,
  buildDisplayUrl,
  applyUrlInputToParsed,
} from "./bruUrlSync";
import {
  createBodyEditor,
  canPrettifyBody,
  canFoldBody,
  prettifyBody,
  inferBodyType,
  normalizeBodyType,
  BODY_TYPE_OPTIONS,
  type BodyEditorHandle,
} from "./bruBodyEditor";

export const BRU_VIEW_TYPE = "bru-view";

/** Overrides Obsidian readable line width on the bru-view leaf. */
export const BRU_VIEW_LEAF_STYLES = `
  .workspace-leaf-content[data-type="bru-view"] {
    --file-line-width: 100%;
    --line-width: 100%;
    --max-width: none;
  }
  .workspace-leaf-content[data-type="bru-view"] .view-content,
  .workspace-leaf-content[data-type="bru-view"] .view-content > * {
    max-width: none !important;
    width: 100% !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
  }
  .workspace-leaf-content[data-type="bru-view"] .cm-sizer,
  .workspace-leaf-content[data-type="bru-view"] .cm-contentContainer,
  .workspace-leaf-content[data-type="bru-view"] .markdown-source-view,
  .workspace-leaf-content[data-type="bru-view"] .markdown-preview-sizer {
    max-width: none !important;
    width: 100% !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
  }
  .workspace-leaf-content[data-type="bru-view"] .bru-view-content,
  .workspace-leaf-content[data-type="bru-view"] .bru-view-root {
    max-width: none !important;
    width: 100% !important;
    box-sizing: border-box;
  }
  .workspace-leaf-content[data-type="bru-view"] {
    height: 100%;
  }
  .workspace-leaf-content[data-type="bru-view"] .view-content {
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .workspace-leaf-content[data-type="bru-view"] .bru-view-content {
    flex: 1;
    min-height: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
`;

export function registerBruViewLeafStyles(plugin: Plugin): void {
  const style = document.createElement("style");
  style.id = "brunet-bru-view-leaf";
  style.textContent = BRU_VIEW_LEAF_STYLES;
  document.head.appendChild(style);
  plugin.register(() => style.remove());
}

export class BruFileView extends TextFileView {
  private contentDiv: HTMLDivElement;
  private parsed: BruFile | null = null;
  private isYml = false;
  private saveTimer: number | null = null;
  private tabNav: HTMLElement | null = null;
  private tabHolder: HTMLElement | null = null;
  private consolePanel: HTMLElement | null = null;
  private urlInput: HTMLInputElement | null = null;
  private bodyEditor: BodyEditorHandle | null = null;
  private lastConsole: BruRunResult | null = null;
  private consoleLoading = false;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.applyFullWidthLayout();
    this.contentDiv = this.contentEl.createDiv({ cls: "bru-view-root" });
  }

  async onOpen(): Promise<void> {
    this.applyFullWidthLayout();
  }

  /** Obsidian constrains .view-content via --file-line-width; override on the leaf. */
  private applyFullWidthLayout(): void {
    this.containerEl.addClass("bru-file-view-leaf");
    this.contentEl.addClass("bru-view-content");

    const leafContent = this.containerEl.closest(
      ".workspace-leaf-content",
    ) as HTMLElement | null;
    if (leafContent) {
      leafContent.style.setProperty("--file-line-width", "100%");
      leafContent.style.setProperty("--line-width", "100%");
    }
  }

  getViewType(): string {
    return BRU_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file ? this.file.basename : "Brunet Request";
  }

  getIcon(): string {
    return "file-code";
  }

  /** Called by Obsidian when content changes or file is first loaded. */
  onLoadFile(file: TFile): Promise<void> {
    this.render();
    return super.onLoadFile(file);
  }

  setViewData(data: string, clear: boolean): void {
    this.data = data;
    if (clear) {
      this.contentDiv.empty();
      this.parsed = null;
    }
    this.render();
  }

  getViewData(): string {
    return this.data;
  }

  clear(): void {
    this.data = "";
    this.contentDiv.empty();
  }

  private render(): void {
    this.destroyBodyEditor();
    this.contentDiv.empty();

    if (!this.data) {
      this.contentDiv.createEl("p", {
        text: "Empty file.",
        cls: "bru-empty",
      });
      return;
    }

    this.isYml = isBrunoYml(this.data);
    this.parsed = this.isYml
      ? parseBruYml(this.data)
      : parseBruFile(this.data);
    const parsed = this.parsed;
    const filename = this.file?.path ?? "request.bru";
    const editable = !this.isYml;

    if (editable) {
      normalizeParsedUrl(parsed);
    }

    this.renderStyles();
    this.renderHeader(parsed, filename, editable);
    this.renderRequestTabs(parsed, editable);
  }

  private renderStyles(): void {
    // Inject plugin styles into the view container (scoped to .bru-view-root)
    if (this.contentEl.querySelector("style.bru-styles")) return;

    const style = this.contentEl.createEl("style");
    style.className = "bru-styles";
    style.textContent = `
      .bru-view-root {
        font-family: var(--font-interface);
        width: 100%;
        max-width: none;
        min-width: 0;
        box-sizing: border-box;
        padding: var(--size-4-5);
        color: var(--text-normal);
        overflow: hidden;
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        height: 100%;
      }
      .bru-header {
        display: flex;
        align-items: center;
        gap: 1em;
        margin-bottom: 1.5em;
        flex-shrink: 0;
        padding: 1em 1.25em;
        background: var(--background-secondary);
        border-radius: 8px;
        border-left: 4px solid var(--bru-method-color, #61affe);
        flex-wrap: wrap;
      }
      .bru-method-badge {
        font-size: 0.85em;
        font-weight: 700;
        letter-spacing: 0.05em;
        padding: 0.25em 0.65em;
        border-radius: 4px;
        background: var(--bru-method-color, #61affe);
        color: #fff;
        font-family: var(--font-monospace);
        flex-shrink: 0;
      }
      .bru-url {
        font-family: var(--font-monospace);
        font-size: 0.95em;
        word-break: break-all;
        color: var(--text-normal);
        flex: 1;
      }
      .bru-url-input {
        flex: 1;
        min-width: 12em;
        font-family: var(--font-monospace);
        font-size: 0.95em;
        padding: 0.35em 0.55em;
        border-radius: 4px;
        border: 1px solid var(--background-modifier-border);
        background: var(--background-primary);
        color: var(--text-normal);
      }
      .bru-url-input:focus {
        border-color: var(--interactive-accent);
        outline: none;
      }
      .bru-field-input {
        width: 100%;
        font-family: var(--font-monospace);
        font-size: 0.88em;
        padding: 0.3em 0.45em;
        border-radius: 4px;
        border: 1px solid var(--background-modifier-border);
        background: var(--background-primary);
        color: var(--text-normal);
        box-sizing: border-box;
      }
      .bru-field-input:focus {
        border-color: var(--interactive-accent);
        outline: none;
      }
      .bru-body-editor-toolbar {
        display: flex;
        align-items: center;
        gap: var(--size-4-2);
        margin-bottom: var(--size-4-2);
        flex-shrink: 0;
      }
      .bru-body-editor-host {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .bru-body-type-wrap {
        display: flex;
        align-items: center;
        gap: var(--size-2-2);
      }
      .bru-body-type-label {
        font-size: var(--font-ui-smaller);
        color: var(--text-muted);
      }
      .bru-body-type-select {
        font-size: var(--font-ui-small);
        padding: var(--size-2-1) var(--size-4-2);
        border-radius: var(--radius-s);
        border: 1px solid var(--background-modifier-border);
        background: var(--background-primary);
        color: var(--text-normal);
      }
      .bru-body-toolbar-actions {
        display: flex;
        align-items: center;
        gap: var(--size-2-1);
      }
      .bru-body-toolbar-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--size-4-4);
        height: var(--size-4-4);
        padding: 0;
        border-radius: var(--radius-s);
        color: var(--text-muted);
      }
      .bru-body-toolbar-btn:hover {
        color: var(--interactive-accent);
        background: var(--background-modifier-hover);
      }
      .bru-body-toolbar-btn svg {
        width: var(--icon-m);
        height: var(--icon-m);
      }
      .bru-body-fold-hint {
        margin-left: auto;
        font-size: var(--font-ui-smaller);
        color: var(--text-faint);
      }
      .bru-body-cm-mount {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .bru-body-cm-mount .cm-editor {
        width: 100%;
        flex: 1;
        min-height: 0;
        height: 100%;
        display: flex;
        flex-direction: column;
      }
      .bru-body-cm-mount .cm-scroller {
        flex: 1;
        min-height: 0;
        overflow: auto;
      }
      .bru-kv-actions {
        display: flex;
        gap: var(--size-2-2);
        margin-top: var(--size-4-2);
      }
      .bru-kv-table-editable td:first-child {
        width: 2em;
      }
      .bru-kv-table-editable td:last-child {
        width: 2.5em;
        text-align: center;
      }
      .bru-kv-remove {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: var(--size-2-2);
        width: var(--size-4-6);
        height: var(--size-4-6);
        min-width: unset;
        border: none;
        background: transparent;
        box-shadow: none;
        color: var(--text-muted);
        --icon-size: var(--icon-xs);
      }
      .bru-kv-remove:hover {
        color: var(--text-error);
        background: var(--background-modifier-hover);
      }
      .bru-kv-add {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: var(--size-2-2);
        width: var(--size-4-6);
        height: var(--size-4-6);
        min-width: unset;
        border: none;
        background: transparent;
        box-shadow: none;
        color: var(--text-muted);
        --icon-size: var(--icon-xs);
      }
      .bru-kv-add:hover {
        color: var(--interactive-accent);
        background: var(--background-modifier-hover);
      }
      .bru-kv-enabled {
        width: 1em;
        vertical-align: middle;
      }
      /*
       * Use vertical-tab-nav-item for native tab chrome only — NOT
       * vertical-tabs-container (its row flex puts content beside the nav).
       */
      .brunet-request-tabs {
        margin-bottom: var(--size-4-4);
        width: 100%;
        min-width: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
      }
      .brunet-tab-nav {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        gap: 0;
        width: 100%;
        min-width: 0;
        border-bottom: 1px solid var(--background-modifier-border);
        flex-shrink: 0;
      }
      .brunet-tab-nav .vertical-tab-nav-item {
        flex: 0 0 auto;
        width: auto;
        margin: 0;
        padding: var(--size-4-2) var(--size-4-4);
        border-radius: var(--radius-s) var(--radius-s) 0 0;
        box-shadow: none;
      }
      .brunet-tab-body {
        width: 100%;
        min-width: 0;
        min-height: 0;
        flex: 1;
        padding: var(--size-4-4);
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .brunet-request-tabs .brunet-tab-panel {
        display: none;
      }
      .brunet-request-tabs .brunet-tab-panel.is-active {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        overflow: auto;
      }
      .brunet-request-tabs .brunet-tab-panel[data-tab="body"].is-active {
        overflow: hidden;
      }
      .bru-body-tab-content {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        height: 100%;
      }
      .brunet-request-tabs .brunet-tab-count {
        margin-left: var(--size-2-2);
        color: var(--text-faint);
        font-size: var(--font-ui-smaller);
        font-weight: var(--font-normal);
      }
      .brunet-request-tabs .vertical-tab-nav-item.is-active .brunet-tab-count {
        color: var(--text-muted);
      }
      .brunet-request-tabs .bru-kv-table-editable {
        width: 100%;
        table-layout: fixed;
      }
      .bru-tab-empty {
        color: var(--text-muted);
        font-style: italic;
        font-size: var(--font-ui-small);
      }
      .bru-param-group {
        margin-bottom: var(--size-4-4);
      }
      .bru-param-group:last-child {
        margin-bottom: 0;
      }
      .bru-param-heading {
        margin: 0 0 var(--size-4-2);
        font-size: var(--font-ui-small);
        font-weight: var(--font-semibold);
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .bru-more-sections details.bru-section {
        margin-bottom: 0.5em;
      }
      .bru-header-actions {
        display: flex;
        align-items: center;
        gap: var(--size-2-2);
        margin-left: auto;
        flex-shrink: 0;
      }
      .bru-copy-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: var(--size-2-2);
        width: var(--size-4-6);
        height: var(--size-4-6);
        border: none;
        background: transparent;
        box-shadow: none;
        color: var(--text-muted);
        --icon-size: var(--icon-xs);
      }
      .bru-copy-btn:hover {
        color: var(--interactive-accent);
        background: var(--background-modifier-hover);
      }
      details.bru-section {
        margin-bottom: 0.75em;
        border: 1px solid var(--background-modifier-border);
        border-radius: 6px;
        overflow: hidden;
      }
      details.bru-section[open] > summary {
        border-bottom: 1px solid var(--background-modifier-border);
      }
      details.bru-section summary {
        cursor: pointer;
        padding: 0.55em 1em;
        font-size: 0.88em;
        font-weight: 600;
        user-select: none;
        background: var(--background-secondary);
        list-style: none;
        display: flex;
        align-items: center;
        gap: 0.5em;
      }
      details.bru-section summary::-webkit-details-marker { display: none; }
      details.bru-section summary::before {
        content: "▶";
        font-size: 0.75em;
        transition: transform 0.15s;
        display: inline-block;
        color: var(--text-muted);
      }
      details.bru-section[open] summary::before {
        transform: rotate(90deg);
      }
      .bru-section-count {
        margin-left: auto;
        font-size: 0.78em;
        color: var(--text-muted);
        font-weight: 400;
      }
      .bru-section-body {
        padding: 0.75em 1em;
        background: var(--background-primary);
      }
      .bru-kv-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.88em;
        font-family: var(--font-monospace);
      }
      .bru-kv-table tr {
        border-bottom: 1px solid var(--background-modifier-border);
      }
      .bru-kv-table tr:last-child { border-bottom: none; }
      .bru-kv-table td {
        padding: 0.35em 0.5em;
        vertical-align: top;
      }
      .bru-kv-table .bru-key {
        color: var(--text-accent);
        white-space: nowrap;
        width: 40%;
      }
      .bru-kv-table .bru-value {
        color: var(--text-normal);
        word-break: break-all;
      }
      .bru-kv-table tr.bru-disabled {
        opacity: 0.45;
        text-decoration: line-through;
      }
      .bru-var-ref {
        color: #e8a838;
        background: rgba(232,168,56,0.12);
        border-radius: 3px;
        padding: 0 0.15em;
      }
      .bru-code-block {
        background: var(--background-secondary);
        border-radius: 4px;
        padding: 0.75em 1em;
        font-family: var(--font-monospace);
        font-size: 0.85em;
        white-space: pre-wrap;
        overflow-x: auto;
        color: var(--text-normal);
        line-height: 1.55;
      }
      .bru-assert-op {
        color: #49cc90;
        font-weight: 600;
        margin-left: 0.3em;
      }
      .bru-docs-body {
        font-size: 0.9em;
        line-height: 1.6;
        white-space: pre-wrap;
        color: var(--text-normal);
      }
      .bru-empty {
        color: var(--text-muted);
        font-style: italic;
      }
      .bru-section-icon {
        font-size: 0.9em;
      }
      .bru-send-btn {
        flex-shrink: 0;
        cursor: pointer;
        padding: 0.3em 0.9em;
        border-radius: 4px;
        border: none;
        background: var(--interactive-accent);
        color: #fff;
        font-size: 0.82em;
        font-weight: 600;
        transition: opacity 0.15s;
      }
      .bru-send-btn:hover {
        opacity: 0.88;
      }
      .bru-send-btn:disabled {
        opacity: 0.45;
        cursor: default;
      }
      .bru-loading {
        color: var(--text-muted);
        font-style: italic;
        font-size: 0.88em;
        padding: 0.75em 0;
      }
      .bru-console-section {
        margin-bottom: var(--size-4-5);
      }
      .bru-console-section:last-child {
        margin-bottom: 0;
      }
      .bru-console-heading {
        margin: 0 0 var(--size-4-2);
        font-size: var(--font-ui-small);
        font-weight: var(--font-semibold);
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .bru-console-meta {
        font-size: var(--font-ui-smaller);
        color: var(--text-faint);
        margin-bottom: var(--size-4-3);
      }
      .bru-console-req-line {
        display: flex;
        align-items: flex-start;
        gap: var(--size-4-2);
        margin-bottom: var(--size-4-3);
        flex-wrap: wrap;
      }
      .bru-console-req-line .bru-method-badge {
        flex-shrink: 0;
        margin-top: 0.15em;
      }
      .bru-console-url {
        font-family: var(--font-monospace);
        font-size: var(--font-ui-small);
        word-break: break-all;
        color: var(--text-normal);
        flex: 1;
        min-width: 0;
      }
      .bru-res-status-row {
        display: flex;
        align-items: center;
        gap: 0.6em;
        margin-bottom: 0.75em;
        flex-wrap: wrap;
      }
      .bru-res-badge {
        font-family: var(--font-monospace);
        font-size: 0.9em;
        font-weight: 700;
        padding: 0.2em 0.6em;
        border-radius: 4px;
        color: #fff;
      }
      .bru-res-duration {
        color: var(--text-muted);
        font-size: 0.8em;
        margin-left: auto;
      }
      .bru-res-error {
        background: rgba(249,62,62,0.12);
        border: 1px solid #f93e3e;
        border-radius: 4px;
        color: #f93e3e;
        padding: 0.6em 0.9em;
        font-size: 0.88em;
        margin-bottom: 0.75em;
        word-break: break-word;
      }
    `;
  }

  private getParsedForRequest(): BruFile {
    return this.parsed ?? parseBruFile(this.data);
  }

  private scheduleCommit(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.commitEdits();
      this.saveTimer = null;
    }, 400);
  }

  private commitEdits(): void {
    if (!this.parsed || this.isYml) return;

    const newRaw = serializeBruFile(this.parsed);
    if (newRaw === this.data) return;

    this.data = newRaw;
    this.parsed.raw = newRaw;
    this.updateRawPreview();
    this.requestSave();
  }

  private updateRawPreview(): void {
    const rawEl = this.contentDiv.querySelector(".bru-raw-source");
    if (rawEl) rawEl.textContent = this.data;
  }

  /** Update URL bar to match current path/query params (resolved URL). */
  private destroyBodyEditor(): void {
    this.bodyEditor?.destroy();
    this.bodyEditor = null;
  }

  private createBodyToolbarIconBtn(
    parent: HTMLElement,
    icon: string,
    label: string,
  ): HTMLButtonElement {
    const btn = parent.createEl("button", {
      cls: "clickable-icon bru-body-toolbar-btn",
      attr: { "aria-label": label, title: label },
    });
    setIcon(btn, icon);
    return btn;
  }

  private syncUrlFromParams(): void {
    if (!this.urlInput || !this.parsed || this.isYml) return;
    this.urlInput.value = buildDisplayUrl(this.parsed);
  }

  private onParamFieldChange(): void {
    this.syncUrlFromParams();
    this.scheduleCommit();
  }

  private renderHeader(parsed: BruFile, filename: string, editable: boolean): void {
    const method = parsed.request.method || "UNKNOWN";
    const url = parsed.request.url || "";
    const color = getMethodColor(method);

    const header = this.contentDiv.createDiv({ cls: "bru-header" });
    header.style.setProperty("--bru-method-color", color);
    header.style.setProperty("border-left-color", color);

    const badge = header.createEl("span", {
      text: method,
      cls: "bru-method-badge",
    });
    badge.style.background = color;

    if (editable) {
      const urlInput = header.createEl("input", {
        type: "text",
        cls: "bru-url-input",
        attr: { placeholder: "https://api.example.com/..." },
      });
      this.urlInput = urlInput;
      urlInput.value = buildDisplayUrl(parsed);
      urlInput.addEventListener("input", () => {
        applyUrlInputToParsed(parsed, urlInput.value);
        this.scheduleCommit();
      });
    } else {
      header.createEl("span", {
        text: url || "(no URL)",
        cls: "bru-url",
      });
    }

    const actions = header.createDiv({ cls: "bru-header-actions" });

    const copyBtn = actions.createEl("button", {
      cls: "clickable-icon bru-copy-btn",
      attr: { "aria-label": "Copy bru run command" },
    });
    setIcon(copyBtn, "copy");
    copyBtn.addEventListener("click", () => {
      const cmd = `bru run "${filename}"`;
      navigator.clipboard.writeText(cmd).then(() => {
        new Notice(`Copied: ${cmd}`);
      }).catch(() => {
        new Notice(`bru run "${filename}"`);
      });
    });

    const sendBtn = actions.createEl("button", {
      text: "Send",
      cls: "bru-send-btn",
    });
    sendBtn.addEventListener("click", () => {
      sendBtn.disabled = true;
      this.consoleLoading = true;
      this.refreshConsole();
      if (this.tabNav && this.tabHolder) {
        this.switchTab(this.tabNav, this.tabHolder, "console");
      }

      runBruRequest(this.getParsedForRequest()).then((result) => {
        this.lastConsole = result;
        this.consoleLoading = false;
        this.refreshConsole();
        sendBtn.disabled = false;
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.lastConsole = {
          request: { method: "", url: "", headers: {} },
          response: {
            status: 0,
            statusText: "Error",
            headers: {},
            body: "",
            json: null,
            durationMs: 0,
            error: msg,
          },
        };
        this.consoleLoading = false;
        this.refreshConsole();
        sendBtn.disabled = false;
      });
    });
  }

  private refreshConsole(): void {
    if (this.consolePanel) this.renderConsole(this.consolePanel);
  }

  private renderConsole(container: HTMLElement): void {
    container.empty();

    if (this.consoleLoading) {
      container.createEl("p", { text: "Sending request…", cls: "bru-loading" });
      return;
    }

    if (!this.lastConsole) {
      container.createEl("p", {
        text: "Send a request to inspect the call and response here.",
        cls: "bru-tab-empty",
      });
      return;
    }

    container.createEl("div", {
      text: `Last run at ${new Date().toLocaleTimeString()}`,
      cls: "bru-console-meta",
    });

    const reqSection = container.createDiv({ cls: "bru-console-section" });
    reqSection.createEl("h4", { text: "Request", cls: "bru-console-heading" });
    this.renderRequestInto(reqSection, this.lastConsole.request);

    const resSection = container.createDiv({ cls: "bru-console-section" });
    resSection.createEl("h4", { text: "Response", cls: "bru-console-heading" });
    this.renderResponseInto(resSection, this.lastConsole.response);
  }

  private renderRequestInto(container: HTMLElement, req: BruRequestSnapshot): void {
    const method = req.method || "GET";
    const line = container.createDiv({ cls: "bru-console-req-line" });
    const badge = line.createEl("span", { text: method, cls: "bru-method-badge" });
    badge.style.background = getMethodColor(method);
    line.createEl("span", { text: req.url || "(no URL)", cls: "bru-console-url" });

    const headerEntries = Object.entries(req.headers);
    if (headerEntries.length > 0) {
      const headersDetails = container.createEl("details", { cls: "bru-section" });
      headersDetails.open = true;
      const headersSummary = headersDetails.createEl("summary");
      headersSummary.createEl("span", { text: "Headers" });
      headersSummary.createEl("span", {
        text: String(headerEntries.length),
        cls: "bru-section-count",
      });
      const headersBody = headersDetails.createDiv({ cls: "bru-section-body" });
      const table = headersBody.createEl("table", { cls: "bru-kv-table" });
      for (const [key, value] of headerEntries) {
        const tr = table.createEl("tr");
        tr.createEl("td", { text: key, cls: "bru-key" });
        tr.createEl("td", { text: value, cls: "bru-value" });
      }
    }

    if (req.body) {
      const bodyDetails = container.createEl("details", { cls: "bru-section" });
      bodyDetails.open = true;
      const bodySummary = bodyDetails.createEl("summary");
      bodySummary.createEl("span", { text: "Body" });
      bodySummary.createEl("span", {
        text: `${req.body.length} chars`,
        cls: "bru-section-count",
      });
      const bodyContent = bodyDetails.createDiv({ cls: "bru-section-body" });
      bodyContent.createDiv({ text: req.body, cls: "bru-code-block" });
    }
  }

  private renderResponseInto(container: HTMLElement, resp: BruResponse): void {
    const statusRow = container.createDiv({ cls: "bru-res-status-row" });

    let badgeColor = "#aaa";
    if (resp.status >= 200 && resp.status < 300) badgeColor = "#49cc90";
    else if (resp.status >= 300 && resp.status < 400) badgeColor = "#61affe";
    else if (resp.status >= 400 && resp.status < 500) badgeColor = "#fca130";
    else if (resp.status >= 500) badgeColor = "#f93e3e";

    const statusBadge = statusRow.createEl("span", {
      text: resp.status ? String(resp.status) : "ERR",
      cls: "bru-res-badge",
    });
    statusBadge.style.background = badgeColor;

    statusRow.createEl("span", { text: resp.statusText });

    statusRow.createEl("span", {
      text: `${resp.durationMs} ms`,
      cls: "bru-res-duration",
    });

    if (resp.error) {
      container.createEl("div", {
        text: resp.error,
        cls: "bru-res-error",
      });
    }

    const headerEntries = Object.entries(resp.headers ?? {});
    if (headerEntries.length > 0) {
      const headersDetails = container.createEl("details", { cls: "bru-section" });
      const headersSummary = headersDetails.createEl("summary");
      headersSummary.createEl("span", { text: "Response Headers" });
      headersSummary.createEl("span", {
        text: String(headerEntries.length),
        cls: "bru-section-count",
      });
      const headersBody = headersDetails.createDiv({ cls: "bru-section-body" });
      const table = headersBody.createEl("table", { cls: "bru-kv-table" });
      for (const [key, value] of headerEntries) {
        const tr = table.createEl("tr");
        tr.createEl("td", { text: key, cls: "bru-key" });
        tr.createEl("td", { text: value, cls: "bru-value" });
      }
    }

    if (resp.body || resp.json !== null) {
      const bodyDetails = container.createEl("details", { cls: "bru-section" });
      bodyDetails.open = true;
      const bodySummary = bodyDetails.createEl("summary");
      bodySummary.createEl("span", { text: "Response Body" });

      const bodyLength = resp.body ? resp.body.length : 0;
      const note = resp.json !== null ? "JSON" : `${bodyLength} chars`;
      bodySummary.createEl("span", { text: note, cls: "bru-section-count" });

      const bodyContent = bodyDetails.createDiv({ cls: "bru-section-body" });
      const codeBlock = bodyContent.createDiv({ cls: "bru-code-block" });

      if (resp.json !== null) {
        codeBlock.textContent = JSON.stringify(resp.json, null, 2);
      } else {
        codeBlock.textContent = resp.body;
      }
    }
  }

  private renderRequestTabs(parsed: BruFile, editable: boolean): void {
    const tabs = this.contentDiv.createDiv({ cls: "brunet-request-tabs" });
    const tabNav = tabs.createDiv({ cls: "brunet-tab-nav" });
    const holder = tabs.createDiv({ cls: "brunet-tab-body" });
    this.tabNav = tabNav;
    this.tabHolder = holder;

    const headerCount = parsed.headers.filter((h) => h.key.trim()).length;
    const bodyLabel = parsed.bodyType ? `Body (${parsed.bodyType})` : "Body";

    const headersPanel = this.createTab(
      tabNav,
      holder,
      "headers",
      "Headers",
      headerCount,
      true,
    );
    if (editable) {
      this.renderEditableHeaders(headersPanel, parsed);
    } else if (parsed.headers.length) {
      this.renderKeyValueTable(headersPanel, parsed.headers);
    } else {
      headersPanel.createEl("p", { text: "No headers.", cls: "bru-tab-empty" });
    }

    const bodyPanel = this.createTab(tabNav, holder, "body", bodyLabel);
    bodyPanel.addClass("brunet-tab-panel-body");
    this.renderBodyInto(bodyPanel, parsed, editable);

    const paramCount =
      parsed.query.filter((q) => q.key.trim()).length +
      parsed.path.filter((p) => p.key.trim()).length;
    const paramsPanel = this.createTab(
      tabNav,
      holder,
      "params",
      "Params",
      paramCount,
    );
    this.renderParamsTab(paramsPanel, parsed, editable);

    const consoleBadge = this.lastConsole?.response.status;
    const consolePanel = this.createTab(
      tabNav,
      holder,
      "console",
      "Console",
      consoleBadge,
    );
    this.consolePanel = consolePanel;
    this.renderConsole(consolePanel);

    const morePanel = this.createTab(tabNav, holder, "more", "More");
    const moreSections = morePanel.createDiv({ cls: "bru-more-sections" });
    this.renderRequestDetails(parsed, moreSections);
    this.renderKeyValueSection(
      "Variables (Pre-Request)",
      parsed.varsPreRequest,
      "vars-pre",
      "",
      moreSections,
    );
    this.renderKeyValueSection(
      "Variables (Post-Response)",
      parsed.varsPostResponse,
      "vars-post",
      "",
      moreSections,
    );
    this.renderScriptSection(
      "Script: Pre-Request",
      parsed.scriptPreRequest,
      "script-pre",
      moreSections,
    );
    this.renderScriptSection(
      "Script: Post-Response",
      parsed.scriptPostResponse,
      "script-post",
      moreSections,
    );
    this.renderAssertions(parsed, moreSections);
    this.renderDocs(parsed, moreSections);
    this.renderRawSection(parsed, moreSections);

    if (!moreSections.childElementCount) {
      morePanel.createEl("p", { text: "No additional sections.", cls: "bru-tab-empty" });
    }
  }

  private createTab(
    tabNav: HTMLElement,
    holder: HTMLElement,
    id: string,
    label: string,
    count?: number,
    active = false,
  ): HTMLElement {
    const navItem = tabNav.createDiv({
      cls: "vertical-tab-nav-item mod-lean",
    });
    navItem.dataset.tab = id;
    navItem.setText(label);
    if (active) navItem.addClass("is-active");
    if (count !== undefined && count > 0) {
      navItem.createSpan({ cls: "brunet-tab-count", text: String(count) });
    }

    const panel = holder.createDiv({ cls: "brunet-tab-panel" });
    panel.dataset.tab = id;
    if (active) panel.addClass("is-active");

    navItem.addEventListener("click", () => this.switchTab(tabNav, holder, id));
    return panel;
  }

  private switchTab(tabNav: HTMLElement, holder: HTMLElement, id: string): void {
    tabNav.querySelectorAll<HTMLElement>(".vertical-tab-nav-item").forEach((item) => {
      item.classList.toggle("is-active", item.dataset.tab === id);
    });
    holder.querySelectorAll<HTMLElement>(".brunet-tab-panel").forEach((panel) => {
      panel.classList.toggle("is-active", panel.dataset.tab === id);
    });
  }

  private renderParamsTab(
    container: HTMLElement,
    parsed: BruFile,
    editable: boolean,
  ): void {
    if (editable) {
      const pathGroup = container.createDiv({ cls: "bru-param-group" });
      pathGroup.createEl("h4", { text: "Path Parameters", cls: "bru-param-heading" });
      this.renderEditableKeyValues(pathGroup, parsed.path, {
        keyPlaceholder: "Parameter name",
        valuePlaceholder: "Value",
        addAriaLabel: "Add path parameter",
        removeLabel: "Remove path parameter",
        reflectInUrl: true,
      });

      const queryGroup = container.createDiv({ cls: "bru-param-group" });
      queryGroup.createEl("h4", { text: "Query Parameters", cls: "bru-param-heading" });
      this.renderEditableKeyValues(queryGroup, parsed.query, {
        keyPlaceholder: "Parameter name",
        valuePlaceholder: "Value",
        addAriaLabel: "Add query parameter",
        removeLabel: "Remove query parameter",
        reflectInUrl: true,
      });
      return;
    }

    const pathEntries = parsed.path.filter((p) => p.key.trim());
    const queryEntries = parsed.query.filter((q) => q.key.trim());

    if (!pathEntries.length && !queryEntries.length) {
      container.createEl("p", {
        text: "No query or path parameters.",
        cls: "bru-tab-empty",
      });
      return;
    }

    if (pathEntries.length) {
      const pathGroup = container.createDiv({ cls: "bru-param-group" });
      pathGroup.createEl("h4", { text: "Path Parameters", cls: "bru-param-heading" });
      this.renderKeyValueTable(pathGroup, pathEntries);
    }

    if (queryEntries.length) {
      const queryGroup = container.createDiv({ cls: "bru-param-group" });
      queryGroup.createEl("h4", { text: "Query Parameters", cls: "bru-param-heading" });
      this.renderKeyValueTable(queryGroup, queryEntries);
    }
  }

  private renderRequestDetails(parsed: BruFile, parent = this.contentDiv): void {
    // Request details block shown only when extra info exists beyond method/url
    if (
      parsed.request.body === "none" &&
      parsed.request.auth === "none"
    ) return;

    const details = this.makeDetails("Request", "🌐", 0, parent);
    const body = details.createDiv({ cls: "bru-section-body" });
    const table = body.createEl("table", { cls: "bru-kv-table" });

    const rows: [string, string][] = [];
    if (parsed.request.body) rows.push(["body", parsed.request.body]);
    if (parsed.request.auth) rows.push(["auth", parsed.request.auth]);

    for (const [k, v] of rows) {
      const tr = table.createEl("tr");
      tr.createEl("td", { text: k, cls: "bru-key" });
      const valueTd = tr.createEl("td", { cls: "bru-value" });
      this.renderValueWithVars(valueTd, v);
    }
  }

  private renderEditableHeaders(container: HTMLElement, parsed: BruFile): void {
    this.renderEditableKeyValues(container, parsed.headers, {
      keyPlaceholder: "Header name",
      valuePlaceholder: "Header value",
      addAriaLabel: "Add header",
      removeLabel: "Remove header",
    });
  }

  private renderEditableKeyValues(
    container: HTMLElement,
    entries: BruKeyValue[],
    opts: {
      keyPlaceholder: string;
      valuePlaceholder: string;
      addAriaLabel: string;
      removeLabel: string;
      reflectInUrl?: boolean;
    },
  ): void {
    const onFieldChange = opts.reflectInUrl
      ? () => this.onParamFieldChange()
      : () => this.scheduleCommit();
    const table = container.createEl("table", {
      cls: "bru-kv-table bru-kv-table-editable",
    });

    const renderRows = () => {
      table.empty();
      if (!entries.length) {
        entries.push({ key: "", value: "", enabled: true });
      }

      entries.forEach((entry, index) => {
        const tr = table.createEl("tr");
        if (!entry.enabled) tr.addClass("bru-disabled");

        const enabledTd = tr.createEl("td");
        const enabledCb = enabledTd.createEl("input", {
          type: "checkbox",
          cls: "bru-kv-enabled",
        });
        enabledCb.checked = entry.enabled;
        enabledCb.addEventListener("change", () => {
          entry.enabled = enabledCb.checked;
          tr.toggleClass("bru-disabled", !entry.enabled);
          onFieldChange();
        });

        const keyTd = tr.createEl("td", { cls: "bru-key" });
        const keyInput = keyTd.createEl("input", {
          type: "text",
          cls: "bru-field-input",
          attr: { placeholder: opts.keyPlaceholder },
        });
        keyInput.value = entry.key;
        keyInput.addEventListener("input", () => {
          entry.key = keyInput.value;
          onFieldChange();
        });

        const valueTd = tr.createEl("td", { cls: "bru-value" });
        const valueInput = valueTd.createEl("input", {
          type: "text",
          cls: "bru-field-input",
          attr: { placeholder: opts.valuePlaceholder },
        });
        valueInput.value = entry.value;
        valueInput.addEventListener("input", () => {
          entry.value = valueInput.value;
          onFieldChange();
        });

        const actionTd = tr.createEl("td");
        const removeBtn = actionTd.createEl("button", {
          cls: "clickable-icon bru-kv-remove",
          attr: { "aria-label": opts.removeLabel },
        });
        setIcon(removeBtn, "trash-2");
        removeBtn.addEventListener("click", () => {
          entries.splice(index, 1);
          renderRows();
          onFieldChange();
        });
      });
    };

    renderRows();

    const actions = container.createDiv({ cls: "bru-kv-actions" });
    const addBtn = actions.createEl("button", {
      cls: "clickable-icon bru-kv-add",
      attr: { "aria-label": opts.addAriaLabel },
    });
    setIcon(addBtn, "plus");
    addBtn.addEventListener("click", () => {
      entries.push({ key: "", value: "", enabled: true });
      renderRows();
      onFieldChange();
      const inputs = table.querySelectorAll<HTMLInputElement>(".bru-field-input");
      inputs[inputs.length - 2]?.focus();
    });
  }

  private renderKeyValueTable(container: HTMLElement, entries: BruKeyValue[]): void {
    const table = container.createEl("table", { cls: "bru-kv-table" });
    for (const entry of entries) {
      const tr = table.createEl("tr");
      if (!entry.enabled) tr.addClass("bru-disabled");
      tr.createEl("td", { text: entry.key, cls: "bru-key" });
      const valueTd = tr.createEl("td", { cls: "bru-value" });
      this.renderValueWithVars(valueTd, entry.value);
    }
  }

  private renderKeyValueSection(
    title: string,
    entries: BruKeyValue[],
    _id: string,
    icon = "",
    parent: HTMLElement = this.contentDiv,
  ): void {
    if (!entries.length) return;

    const details = this.makeDetails(title, icon, entries.length, parent);
    const body = details.createDiv({ cls: "bru-section-body" });
    this.renderKeyValueTable(body, entries);
  }

  private renderBodyInto(
    container: HTMLElement,
    parsed: BruFile,
    editable: boolean,
  ): void {
    if (!editable && !parsed.body.trim()) {
      container.createEl("p", { text: "No body.", cls: "bru-tab-empty" });
      return;
    }

    if (editable) {
      container.empty();
      container.addClass("bru-body-tab-content");

      if (!parsed.bodyType) {
        parsed.bodyType = inferBodyType(parsed.body);
      }

      const toolbar = container.createDiv({ cls: "bru-body-editor-toolbar" });
      const typeWrap = toolbar.createDiv({ cls: "bru-body-type-wrap" });
      typeWrap.createSpan({ text: "Type", cls: "bru-body-type-label" });

      const typeSelect = typeWrap.createEl("select", { cls: "bru-body-type-select" });
      for (const option of BODY_TYPE_OPTIONS) {
        const opt = typeSelect.createEl("option", {
          text: option.toUpperCase(),
          value: option,
        });
        if (option === normalizeBodyType(parsed.bodyType)) {
          opt.selected = true;
        }
      }

      const toolbarActions = toolbar.createDiv({ cls: "bru-body-toolbar-actions" });

      const prettifyBtn = this.createBodyToolbarIconBtn(
        toolbarActions,
        "code-2",
        "Prettify",
      );
      const collapseAllBtn = this.createBodyToolbarIconBtn(
        toolbarActions,
        "fold-vertical",
        "Collapse all",
      );
      const expandAllBtn = this.createBodyToolbarIconBtn(
        toolbarActions,
        "unfold-vertical",
        "Expand all",
      );

      const foldHint = toolbar.createSpan({
        text: "Click ▸ in the gutter to fold blocks",
        cls: "bru-body-fold-hint",
      });

      const editorHost = container.createDiv({ cls: "bru-body-editor-host" });

      const syncToolbarForBodyType = (bodyType: string) => {
        const structured = canPrettifyBody(bodyType);
        prettifyBtn.hidden = !structured;
        collapseAllBtn.hidden = !canFoldBody(bodyType);
        expandAllBtn.hidden = !canFoldBody(bodyType);
        foldHint.hidden = !canFoldBody(bodyType);
      };

      const mountEditor = () => {
        this.destroyBodyEditor();
        editorHost.empty();
        const bodyType = normalizeBodyType(parsed.bodyType);
        syncToolbarForBodyType(bodyType);
        this.bodyEditor = createBodyEditor(
          editorHost,
          parsed.body,
          bodyType,
          (value) => {
            parsed.body = value;
            this.scheduleCommit();
          },
        );
      };

      syncToolbarForBodyType(parsed.bodyType);
      mountEditor();

      typeSelect.addEventListener("change", () => {
        parsed.bodyType = normalizeBodyType(typeSelect.value);
        mountEditor();
        this.scheduleCommit();
      });

      prettifyBtn.addEventListener("click", () => {
        if (!this.bodyEditor || !this.parsed) return;
        const bodyType = normalizeBodyType(this.parsed.bodyType);
        try {
          const formatted = prettifyBody(this.bodyEditor.getValue(), bodyType);
          this.bodyEditor.setValue(formatted);
          this.parsed.body = formatted;
          this.scheduleCommit();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          new Notice(`Prettify failed: ${msg}`);
        }
      });

      collapseAllBtn.addEventListener("click", () => {
        this.bodyEditor?.foldAll();
      });

      expandAllBtn.addEventListener("click", () => {
        this.bodyEditor?.unfoldAll();
      });
    } else {
      const code = container.createDiv({ cls: "bru-code-block" });
      this.renderValueWithVars(code, parsed.body.trim());
    }
  }

  private renderScriptSection(
    title: string,
    scriptContent: string,
    _id: string,
    parent: HTMLElement = this.contentDiv,
  ): void {
    if (!scriptContent.trim()) return;

    const details = this.makeDetails(title, "⚡", 0, parent);
    const body = details.createDiv({ cls: "bru-section-body" });
    const code = body.createDiv({ cls: "bru-code-block" });
    this.renderValueWithVars(code, scriptContent.trim());
  }

  private renderAssertions(parsed: BruFile, parent: HTMLElement = this.contentDiv): void {
    if (!parsed.assertions.length) return;

    const details = this.makeDetails("Assertions", "✅", parsed.assertions.length, parent);
    const body = details.createDiv({ cls: "bru-section-body" });
    const table = body.createEl("table", { cls: "bru-kv-table" });

    for (const entry of parsed.assertions) {
      if (!entry.enabled) continue;
      const tr = table.createEl("tr");
      tr.createEl("td", { text: entry.key, cls: "bru-key" });
      const valueTd = tr.createEl("td", { cls: "bru-value" });

      // The value is like "eq 200" or "isNumber" — split operator from arg
      const parts = entry.value.split(/\s+/);
      if (parts.length >= 1) {
        valueTd.createEl("span", {
          text: parts[0],
          cls: "bru-assert-op",
        });
        if (parts.length > 1) {
          valueTd.createSpan({ text: " " + parts.slice(1).join(" ") });
        }
      }
    }
  }

  private renderDocs(parsed: BruFile, parent: HTMLElement = this.contentDiv): void {
    if (!parsed.docs.trim()) return;

    const details = this.makeDetails("Documentation", "📝", 0, parent);
    const body = details.createDiv({ cls: "bru-section-body" });
    body.createEl("div", {
      text: parsed.docs.trim(),
      cls: "bru-docs-body",
    });
  }

  private renderRawSection(parsed: BruFile, parent: HTMLElement = this.contentDiv): void {
    const details = this.makeDetails("Raw Source", "🗒", 0, parent);
    // Start collapsed (default)
    const body = details.createDiv({ cls: "bru-section-body" });
    body.createDiv({ text: parsed.raw, cls: "bru-code-block bru-raw-source" });
  }

  /**
   * Creates a <details> element with a styled <summary> and appends it to contentDiv.
   * Returns the <details> element for further children to be appended.
   */
  private makeDetails(
    title: string,
    icon: string,
    count: number,
    parent: HTMLElement = this.contentDiv,
  ): HTMLDetailsElement {
    const details = parent.createEl("details", {
      cls: "bru-section",
    }) as HTMLDetailsElement;
    details.open = title !== "Raw Source"; // open all except raw

    const summary = details.createEl("summary");
    if (icon) {
      summary.createEl("span", { text: icon + " ", cls: "bru-section-icon" });
    }
    summary.createEl("span", { text: title });
    if (count > 0) {
      summary.createEl("span", {
        text: `${count}`,
        cls: "bru-section-count",
      });
    }

    return details;
  }

  /**
   * Renders a text value into an element, highlighting {{variable}} references.
   */
  private renderValueWithVars(container: HTMLElement, text: string): void {
    // Split on {{...}} patterns
    const parts = text.split(/({{[^}]*}})/g);
    for (const part of parts) {
      if (part.startsWith("{{") && part.endsWith("}}")) {
        container.createEl("span", { text: part, cls: "bru-var-ref" });
      } else {
        container.appendText(part);
      }
    }
  }
}
