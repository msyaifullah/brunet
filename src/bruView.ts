/**
 * Custom Obsidian FileView for .bru files.
 *
 * Renders a rich HTML preview of the Bruno request file with:
 *  - Prominent METHOD + URL header
 *  - Collapsible <details> sections for each block type
 *  - A button to copy the `bru run <filename>` command
 *  - Syntax-highlighted freeform content (scripts, body)
 */

import { Plugin, TextFileView, WorkspaceLeaf, Notice, TFile } from "obsidian";
import {
  parseBruFile,
  serializeBruFile,
  BruFile,
  BruKeyValue,
  getMethodColor,
} from "./bruParser";
import { parseBruYml, isBrunoYml } from "./bruYmlParser";
import { runBruRequest, BruResponse } from "./bruRunner";

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
  private responsePanel: HTMLDivElement;
  private parsed: BruFile | null = null;
  private isYml = false;
  private saveTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.applyFullWidthLayout();
    this.contentDiv = this.contentEl.createDiv({ cls: "bru-view-root" });
    this.responsePanel = this.contentDiv.createDiv({ cls: "bru-response-panel" });
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
    this.contentDiv.empty();

    if (!this.data) {
      this.contentDiv.createEl("p", {
        text: "Empty file.",
        cls: "bru-empty",
      });
      // Re-create response panel after empty
      this.responsePanel = this.contentDiv.createDiv({ cls: "bru-response-panel" });
      return;
    }

    this.isYml = isBrunoYml(this.data);
    this.parsed = this.isYml
      ? parseBruYml(this.data)
      : parseBruFile(this.data);
    const parsed = this.parsed;
    const filename = this.file?.path ?? "request.bru";
    const editable = !this.isYml;

    this.renderStyles();
    this.renderHeader(parsed, filename, editable);
    this.renderMeta(parsed);
    this.renderRequestDetails(parsed);
    if (editable) {
      this.renderEditableHeaders(parsed);
    } else {
      this.renderKeyValueSection("Headers", parsed.headers, "headers");
    }
    this.renderKeyValueSection("Query Parameters", parsed.query, "query");
    this.renderKeyValueSection("Variables (Pre-Request)", parsed.varsPreRequest, "vars-pre");
    this.renderKeyValueSection("Variables (Post-Response)", parsed.varsPostResponse, "vars-post");
    this.renderBodySection(parsed, editable);
    this.renderScriptSection("Script: Pre-Request", parsed.scriptPreRequest, "script-pre");
    this.renderScriptSection("Script: Post-Response", parsed.scriptPostResponse, "script-post");
    this.renderAssertions(parsed);
    this.renderDocs(parsed);
    this.renderRawSection(parsed);

    // Response panel — always last, re-created fresh on each render
    this.responsePanel = this.contentDiv.createDiv({ cls: "bru-response-panel" });
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
        box-sizing: border-box;
        padding: 1.5em;
        color: var(--text-normal);
      }
      .bru-header {
        display: flex;
        align-items: center;
        gap: 1em;
        margin-bottom: 1.5em;
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
      .bru-body-textarea {
        width: 100%;
        min-height: 8em;
        font-family: var(--font-monospace);
        font-size: 0.85em;
        padding: 0.75em 1em;
        border-radius: 4px;
        border: 1px solid var(--background-modifier-border);
        background: var(--background-secondary);
        color: var(--text-normal);
        line-height: 1.55;
        resize: vertical;
        box-sizing: border-box;
      }
      .bru-body-textarea:focus {
        border-color: var(--interactive-accent);
        outline: none;
      }
      .bru-kv-actions {
        display: flex;
        gap: 0.5em;
        margin-top: 0.6em;
      }
      .bru-kv-btn {
        cursor: pointer;
        padding: 0.25em 0.65em;
        border-radius: 4px;
        border: 1px solid var(--background-modifier-border);
        background: var(--background-secondary);
        color: var(--text-muted);
        font-size: 0.8em;
      }
      .bru-kv-btn:hover {
        color: var(--text-normal);
        border-color: var(--interactive-accent);
      }
      .bru-kv-btn.bru-kv-btn-danger:hover {
        border-color: #f93e3e;
        color: #f93e3e;
      }
      .bru-kv-remove {
        padding: 0.2em 0.45em;
        font-size: 0.75em;
        line-height: 1;
      }
      .bru-kv-enabled {
        width: 1em;
        vertical-align: middle;
      }
      .bru-copy-btn {
        margin-left: auto;
        flex-shrink: 0;
        cursor: pointer;
        padding: 0.3em 0.8em;
        border-radius: 4px;
        border: 1px solid var(--interactive-accent);
        background: transparent;
        color: var(--interactive-accent);
        font-size: 0.82em;
        transition: background 0.15s;
      }
      .bru-copy-btn:hover {
        background: var(--interactive-accent);
        color: #fff;
      }
      .bru-meta-row {
        display: flex;
        gap: 1.5em;
        margin-bottom: 1.25em;
        flex-wrap: wrap;
      }
      .bru-meta-item {
        font-size: 0.82em;
        color: var(--text-muted);
      }
      .bru-meta-item strong {
        color: var(--text-normal);
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
      .bru-response-panel {
        margin-top: 1.25em;
        border-top: 2px solid var(--background-modifier-border);
        padding-top: 1em;
      }
      .bru-response-panel:empty {
        display: none;
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
      urlInput.value = url;
      urlInput.addEventListener("input", () => {
        parsed.request.url = urlInput.value;
        this.scheduleCommit();
      });
    } else {
      header.createEl("span", {
        text: url || "(no URL)",
        cls: "bru-url",
      });
    }

    const copyBtn = header.createEl("button", {
      text: "Copy CLI Command",
      cls: "bru-copy-btn",
    });
    copyBtn.addEventListener("click", () => {
      const cmd = `bru run "${filename}"`;
      navigator.clipboard.writeText(cmd).then(() => {
        new Notice(`Copied: ${cmd}`);
      }).catch(() => {
        new Notice(`bru run "${filename}"`);
      });
    });

    const sendBtn = header.createEl("button", {
      text: "Send",
      cls: "bru-send-btn",
    });
    sendBtn.addEventListener("click", () => {
      sendBtn.disabled = true;
      this.responsePanel.empty();
      this.responsePanel.createEl("p", {
        text: "Sending request…",
        cls: "bru-loading",
      });

      runBruRequest(this.getParsedForRequest()).then(resp => {
        this.renderResponse(resp);
        sendBtn.disabled = false;
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.responsePanel.empty();
        this.responsePanel.createEl("div", { text: `Error: ${msg}`, cls: "bru-res-error" });
        sendBtn.disabled = false;
      });
    });
  }

  private renderResponse(resp: BruResponse): void {
    this.responsePanel.empty();

    // Status row
    const statusRow = this.responsePanel.createDiv({ cls: "bru-res-status-row" });

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

    // Error message
    if (resp.error) {
      this.responsePanel.createEl("div", {
        text: resp.error,
        cls: "bru-res-error",
      });
    }

    // Response headers (collapsible, closed by default)
    const headerEntries = Object.entries(resp.headers ?? {});
    if (headerEntries.length > 0) {
      const headersDetails = this.responsePanel.createEl("details", { cls: "bru-section" });
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

    // Response body (collapsible, open by default)
    if (resp.body || resp.json !== null) {
      const bodyDetails = this.responsePanel.createEl("details", { cls: "bru-section" });
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

  private renderMeta(parsed: BruFile): void {
    if (!parsed.meta.name && !parsed.meta.type) return;

    const row = this.contentDiv.createDiv({ cls: "bru-meta-row" });
    if (parsed.meta.name) {
      const item = row.createDiv({ cls: "bru-meta-item" });
      item.createEl("strong", { text: "Name: " });
      item.createSpan({ text: parsed.meta.name });
    }
    if (parsed.meta.type) {
      const item = row.createDiv({ cls: "bru-meta-item" });
      item.createEl("strong", { text: "Type: " });
      item.createSpan({ text: parsed.meta.type });
    }
    if (parsed.meta.seq) {
      const item = row.createDiv({ cls: "bru-meta-item" });
      item.createEl("strong", { text: "Seq: " });
      item.createSpan({ text: String(parsed.meta.seq) });
    }
    if (parsed.request.auth && parsed.request.auth !== "none") {
      const item = row.createDiv({ cls: "bru-meta-item" });
      item.createEl("strong", { text: "Auth: " });
      item.createSpan({ text: parsed.request.auth });
    }
  }

  private renderRequestDetails(parsed: BruFile): void {
    // Request details block shown only when extra info exists beyond method/url
    if (
      parsed.request.body === "none" &&
      parsed.request.auth === "none"
    ) return;

    const details = this.makeDetails("Request", "🌐", 0);
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

  private renderEditableHeaders(parsed: BruFile): void {
    const details = this.makeDetails("Headers", "", parsed.headers.length);
    details.open = true;
    const body = details.createDiv({ cls: "bru-section-body" });
    const table = body.createEl("table", { cls: "bru-kv-table bru-kv-table-editable" });

    const renderRows = () => {
      table.empty();
      if (!parsed.headers.length) {
        parsed.headers.push({ key: "", value: "", enabled: true });
      }

      parsed.headers.forEach((entry, index) => {
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
          this.scheduleCommit();
        });

        const keyTd = tr.createEl("td", { cls: "bru-key" });
        const keyInput = keyTd.createEl("input", {
          type: "text",
          cls: "bru-field-input",
          attr: { placeholder: "Header name" },
        });
        keyInput.value = entry.key;
        keyInput.addEventListener("input", () => {
          entry.key = keyInput.value;
          this.scheduleCommit();
        });

        const valueTd = tr.createEl("td", { cls: "bru-value" });
        const valueInput = valueTd.createEl("input", {
          type: "text",
          cls: "bru-field-input",
          attr: { placeholder: "Header value" },
        });
        valueInput.value = entry.value;
        valueInput.addEventListener("input", () => {
          entry.value = valueInput.value;
          this.scheduleCommit();
        });

        const actionTd = tr.createEl("td");
        const removeBtn = actionTd.createEl("button", {
          text: "×",
          cls: "bru-kv-btn bru-kv-remove bru-kv-btn-danger",
        });
        removeBtn.addEventListener("click", () => {
          parsed.headers.splice(index, 1);
          renderRows();
          this.scheduleCommit();
        });
      });
    };

    renderRows();

    const actions = body.createDiv({ cls: "bru-kv-actions" });
    const addBtn = actions.createEl("button", {
      text: "+ Add header",
      cls: "bru-kv-btn",
    });
    addBtn.addEventListener("click", () => {
      parsed.headers.push({ key: "", value: "", enabled: true });
      renderRows();
      const inputs = table.querySelectorAll<HTMLInputElement>(".bru-field-input");
      inputs[inputs.length - 2]?.focus();
    });
  }

  private renderKeyValueSection(
    title: string,
    entries: BruKeyValue[],
    _id: string,
    icon = "",
  ): void {
    if (!entries.length) return;

    const details = this.makeDetails(title, icon, entries.length);
    const body = details.createDiv({ cls: "bru-section-body" });
    const table = body.createEl("table", { cls: "bru-kv-table" });

    for (const entry of entries) {
      const tr = table.createEl("tr");
      if (!entry.enabled) tr.addClass("bru-disabled");
      tr.createEl("td", { text: entry.key, cls: "bru-key" });
      const valueTd = tr.createEl("td", { cls: "bru-value" });
      this.renderValueWithVars(valueTd, entry.value);
    }
  }

  private renderBodySection(parsed: BruFile, editable: boolean): void {
    if (!editable && !parsed.body.trim()) return;

    const label = parsed.bodyType
      ? `Body (${parsed.bodyType})`
      : "Body";

    const details = this.makeDetails(label, "📦", 0);
    details.open = true;
    const sectionBody = details.createDiv({ cls: "bru-section-body" });

    if (editable) {
      const textarea = sectionBody.createEl("textarea", {
        cls: "bru-body-textarea",
        attr: { placeholder: "Request body…", spellcheck: "false" },
      });
      textarea.value = parsed.body;
      textarea.addEventListener("input", () => {
        parsed.body = textarea.value;
        this.scheduleCommit();
      });
    } else {
      const code = sectionBody.createDiv({ cls: "bru-code-block" });
      this.renderValueWithVars(code, parsed.body.trim());
    }
  }

  private renderScriptSection(
    title: string,
    scriptContent: string,
    _id: string,
  ): void {
    if (!scriptContent.trim()) return;

    const details = this.makeDetails(title, "⚡", 0);
    const body = details.createDiv({ cls: "bru-section-body" });
    const code = body.createDiv({ cls: "bru-code-block" });
    this.renderValueWithVars(code, scriptContent.trim());
  }

  private renderAssertions(parsed: BruFile): void {
    if (!parsed.assertions.length) return;

    const details = this.makeDetails("Assertions", "✅", parsed.assertions.length);
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

  private renderDocs(parsed: BruFile): void {
    if (!parsed.docs.trim()) return;

    const details = this.makeDetails("Documentation", "📝", 0);
    const body = details.createDiv({ cls: "bru-section-body" });
    body.createEl("div", {
      text: parsed.docs.trim(),
      cls: "bru-docs-body",
    });
  }

  private renderRawSection(parsed: BruFile): void {
    const details = this.makeDetails("Raw Source", "🗒", 0);
    // Start collapsed (default)
    const body = details.createDiv({ cls: "bru-section-body" });
    body.createDiv({ text: parsed.raw, cls: "bru-code-block bru-raw-source" });
  }

  /**
   * Creates a <details> element with a styled <summary> and appends it to contentDiv.
   * Returns the <details> element for further children to be appended.
   */
  private makeDetails(title: string, icon: string, count: number): HTMLDetailsElement {
    const details = this.contentDiv.createEl("details", {
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
