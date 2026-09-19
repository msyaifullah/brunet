/**
 * Custom Obsidian FileView for .bru files.
 *
 * Renders a rich HTML preview of the Bruno request file with:
 *  - Prominent METHOD + URL header
 *  - Tabbed panels for Headers, Body, Params, and More
 *  - Editable URL, headers, and body (saved back to the .bru file)
 *  - A button to copy the `bru run <filename>` command
 */

import { TextFileView, WorkspaceLeaf, Notice, TFile, setIcon } from "obsidian";
import type BrunetPlugin from "./main";
import {
  parseBruFile,
  serializeBruFile,
  getBruBodyContent,
  getBruBodyType,
  BruFile,
  BruKeyValue,
  methodModifierClass,
  statusBadgeClass,
  isFormBodyType,
  parseFormBodyContent,
  serializeFormBodyContent,
  BRU_HTTP_METHODS,
  normalizeBruHttpMethod,
} from "./bruParser";
import {
  parseBruYml,
  isBrunoYml,
  isOpenCollectionYml,
  parseManifestYml,
  isFolderManifestYmlFile,
  isCollectionManifestYmlFile,
  updateYmlFromParsed,
} from "./bruYmlParser";
import { parseBrunoJson, isBrunoJsonFile, BrunoJsonManifest } from "./bruJsonParser";
import { runBruRequest, BruResponse, BruRunResult, BruRequestSnapshot, resolveVars, buildEffectiveVars } from "./bruRunner";
import {
  formatBruRunCommand,
  isBruManifest,
  isEnvironmentFile,
  isAnyFolderManifestFile,
  isAnyCollectionManifestFile,
  loadCollectionVars,
  loadEnvironmentVars,
  saveEnvironmentVars,
  type EnvironmentVarsState,
} from "./bruCollection";
import {
  mountEnvironmentTab as mountEnvironmentTabContent,
  type EnvironmentTabHandle,
} from "./bruEnvironmentTab";
import { renderEditableKeyValueTable } from "./bruKeyValueEditor";
import {
  normalizeParsedUrl,
  buildDisplayUrl,
  getTemplateUrl,
  hasResolvedUrlPreview,
  applyTemplateUrlToParsed,
  syncPathParamsFromTemplate,
  renamePathParamInUrl,
} from "./bruUrlSync";
import {
  createBodyEditor,
  canPrettifyBody,
  canFoldBody,
  prettifyBody,
  inferBodyType,
  inferBodyTypeFromHeaders,
  normalizeBodyType,
  BODY_TYPE_OPTIONS,
  bodyTypeSelectLabel,
  type BodyEditorHandle,
} from "./bruBodyEditor";

export const BRU_VIEW_TYPE = "bru-view";

export class BruFileView extends TextFileView {
  private contentDiv: HTMLDivElement;
  private parsed: BruFile | null = null;
  private isYml = false;
  private isBrunoJson = false;
  private brunoJsonManifest: BrunoJsonManifest | null = null;
  private saveTimer: number | null = null;
  private tabNav: HTMLElement | null = null;
  private tabHolder: HTMLElement | null = null;
  private consolePanel: HTMLElement | null = null;
  private urlInput: HTMLInputElement | null = null;
  private bodyEditor: BodyEditorHandle | null = null;
  private consoleEditors: BodyEditorHandle[] = [];
  private lastConsole: BruRunResult | null = null;
  private consoleLoading = false;
  private collectionVars: Record<string, string> = {};
  private renderGeneration = 0;
  private unregisterEnvListener?: () => void;
  private envPanel: HTMLElement | null = null;
  private envTabHandle: EnvironmentTabHandle | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: BrunetPlugin,
  ) {
    super(leaf);
    this.applyFullWidthLayout();
    this.contentDiv = this.contentEl.createDiv({ cls: "bru-view-root" });
  }

  async onOpen(): Promise<void> {
    this.applyFullWidthLayout();
    this.unregisterEnvListener = this.plugin.onEnvironmentChange(() => {
      void this.refreshCollectionVarsCache();
    });
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile)) return;
        if (!this.file || !this.parsed) return;
        if (!this.isVarsRelatedFile(file)) return;
        void this.refreshCollectionVarsCache();
      }),
    );
  }

  /** Environment, collection, folder manifests, and the open request file. */
  private isVarsRelatedFile(file: TFile): boolean {
    if (this.file && file.path === this.file.path) return true;
    if (isEnvironmentFile(file)) return true;
    if (isAnyCollectionManifestFile(file)) return true;
    if (isAnyFolderManifestFile(file)) return true;
    return false;
  }

  async onClose(): Promise<void> {
    this.unregisterEnvListener?.();
  }

  /** Obsidian constrains .view-content via --file-line-width; override on the leaf. */
  private applyFullWidthLayout(): void {
    this.containerEl.addClass("bru-file-view-leaf");
    this.contentEl.addClass("bru-view-content");
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
    this.destroyConsoleEditors();
    this.envPanel = null;
    this.envTabHandle = null;
    this.contentDiv.empty();
    const renderGen = ++this.renderGeneration;

    if (!this.data) {
      this.contentDiv.createEl("p", {
        text: "Empty file.",
        cls: "bru-empty",
      });
      return;
    }

    this.isBrunoJson = !!this.file && isBrunoJsonFile(this.file);
    const isYamlExt =
      this.file?.extension === "yml" || this.file?.extension === "yaml";
    this.isYml =
      !this.isBrunoJson &&
      isYamlExt &&
      (isBrunoYml(this.data) ||
        (!!this.file &&
          (isFolderManifestYmlFile(this.file) ||
            isCollectionManifestYmlFile(this.file))));

    if (this.isBrunoJson) {
      this.brunoJsonManifest = parseBrunoJson(this.data);
      this.parsed = this.createManifestShell(this.data);
    } else {
      this.brunoJsonManifest = null;
      this.parsed = this.isYml
        ? parseBruYml(this.data)
        : parseBruFile(this.data);
    }
    const parsed = this.parsed;
    const filename = this.file?.path ?? "request.bru";
    const manifestKind = this.resolveManifestKind(parsed);
    const isManifest = manifestKind !== null;
    const editable = !this.isBrunoJson && !isManifest;

    if (editable) {
      normalizeParsedUrl(parsed);
    }

    if (isManifest) {
      this.renderHeader(parsed, filename, editable, manifestKind);
      this.renderManifestPanel(parsed, manifestKind);
    } else {
      void this.renderRequestView(parsed, filename, editable, renderGen);
    }
  }

  /** Load vars first so URL/headers reflect the active environment before tabs mount. */
  private async renderRequestView(
    parsed: BruFile,
    filename: string,
    editable: boolean,
    renderGen: number,
  ): Promise<void> {
    await this.loadCollectionVarsForCurrentFile();
    if (renderGen !== this.renderGeneration || this.parsed !== parsed) return;
    this.renderHeader(parsed, filename, editable, null);
    this.syncUrlFromParams();
    this.renderRequestTabs(parsed, editable);
  }

  private createManifestShell(raw: string): BruFile {
    return {
      meta: { name: "", type: "", seq: 0 },
      request: { method: "", url: "", body: "none", auth: "none" },
      headers: [],
      query: [],
      path: [],
      body: "",
      bodyType: "",
      vars: [],
      varsPreRequest: [],
      varsPostResponse: [],
      scriptPreRequest: "",
      scriptPostResponse: "",
      assertions: [],
      docs: "",
      raw,
    };
  }

  private resolveManifestKind(
    parsed: BruFile,
  ): "folder" | "collection" | "environment" | null {
    if (this.isBrunoJson && this.brunoJsonManifest) return "collection";

    if (this.isYml) {
      const ymlManifest = parseManifestYml(this.data);
      if (ymlManifest?.type === "folder") return "folder";
      if (
        ymlManifest?.type === "collection" ||
        isOpenCollectionYml(this.data)
      ) {
        return "collection";
      }
    }

    if (!this.file) return null;

    if (isEnvironmentFile(this.file)) return "environment";
    if (isAnyFolderManifestFile(this.file) || parsed.meta.type === "folder") {
      return "folder";
    }
    if (
      isAnyCollectionManifestFile(this.file) ||
      parsed.meta.type === "collection"
    ) {
      return "collection";
    }
    if (isBruManifest(parsed, this.file)) return "collection";

    return null;
  }

  private getParsedForRequest(): BruFile {
    return this.parsed ?? parseBruFile(this.data);
  }

  private async mountEnvironmentTab(panel: HTMLElement): Promise<void> {
    if (!this.file) return;
    this.envTabHandle = await mountEnvironmentTabContent({
      panel,
      vault: this.app.vault,
      plugin: this.plugin,
      requestFile: this.file,
      onVarsUpdated: (liveEnvVars) =>
        void this.refreshCollectionVarsCache(liveEnvVars),
    });
  }

  private getEffectiveVars(): Record<string, string> {
    if (!this.parsed) return this.collectionVars;
    return buildEffectiveVars(this.parsed, this.collectionVars);
  }

  private async loadCollectionVarsForCurrentFile(
    liveEnvVars?: Record<string, string>,
  ): Promise<void> {
    if (!this.file) {
      this.collectionVars = {};
      return;
    }
    const useLiveEnv =
      liveEnvVars !== undefined && Object.keys(liveEnvVars).length > 0;
    this.collectionVars = await loadCollectionVars(
      this.app.vault,
      this.file,
      this.plugin.brunetSettings.activeEnvironment,
      useLiveEnv ? { envOverrides: liveEnvVars } : undefined,
    );
  }

  private async refreshCollectionVarsCache(
    liveEnvVars?: Record<string, string>,
  ): Promise<void> {
    await this.loadCollectionVarsForCurrentFile(liveEnvVars);
    this.syncUrlFromParams();
    this.refreshParamResolvedPreviews();
  }

  /** Called when the active environment changes (Environment tab dropdown). */
  async handleActiveEnvironmentChanged(): Promise<void> {
    if (!this.envTabHandle && this.envPanel) {
      await this.mountEnvironmentTab(this.envPanel);
    }
    const handle = this.envTabHandle;
    if (handle) {
      await handle.refresh();
      await this.refreshCollectionVarsCache(handle.getLiveVars());
    } else {
      await this.refreshCollectionVarsCache();
    }
  }

  private async runWithCollectionVars(): Promise<BruRunResult> {
    await this.refreshCollectionVarsCache();
    return runBruRequest(this.getParsedForRequest(), {
      collectionVars: this.collectionVars,
    });
  }

  private scheduleCommit(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      if (this.isYml) {
        this.commitYmlFileEdits();
      } else {
        this.commitEdits();
      }
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

  private commitYmlFileEdits(): void {
    if (!this.parsed || !this.isYml) return;
    const newRaw = updateYmlFromParsed(this.data, this.parsed);
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

  private destroyConsoleEditors(): void {
    for (const editor of this.consoleEditors) {
      editor.destroy();
    }
    this.consoleEditors = [];
  }

  private formatConsoleBodyDisplay(content: string, bodyType: string): string {
    if (!content.trim() || !canPrettifyBody(bodyType)) return content;
    try {
      return prettifyBody(content, bodyType);
    } catch {
      return content;
    }
  }

  /** Read-only CodeMirror viewer (same chrome as Body tab editor). */
  private mountConsoleBodyViewer(
    parent: HTMLElement,
    content: string,
    bodyType: string,
  ): void {
    const wrap = parent.createDiv({ cls: "bru-console-body-view" });
    const toolbar = wrap.createDiv({ cls: "bru-body-editor-toolbar" });
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

    const editorHost = wrap.createDiv({
      cls: "bru-console-body-editor-host bru-body-editor-host",
    });

    const normalizedType = normalizeBodyType(bodyType);
    const display = this.formatConsoleBodyDisplay(content, normalizedType);

    const editor = createBodyEditor(
      editorHost,
      display,
      normalizedType,
      undefined,
      { readOnly: true },
    );
    this.consoleEditors.push(editor);

    const syncToolbar = () => {
      const structured = canPrettifyBody(normalizedType);
      prettifyBtn.hidden = !structured;
      collapseAllBtn.hidden = !canFoldBody(normalizedType);
      expandAllBtn.hidden = !canFoldBody(normalizedType);
    };
    syncToolbar();

    prettifyBtn.addEventListener("click", () => {
      try {
        const formatted = prettifyBody(editor.getValue(), normalizedType);
        editor.setValue(formatted);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        new Notice(`Prettify failed: ${msg}`);
      }
    });

    collapseAllBtn.addEventListener("click", () => editor.foldAll());
    expandAllBtn.addEventListener("click", () => editor.unfoldAll());
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
    if (!this.urlInput || !this.parsed) return;
    this.urlInput.value = getTemplateUrl(this.parsed);
    this.syncUrlTooltip();
  }

  /** Native tooltip on the URL input shows the fully resolved URL on hover. */
  private syncUrlTooltip(): void {
    if (!this.urlInput || !this.parsed) return;
    if (hasResolvedUrlPreview(this.parsed, this.collectionVars)) {
      this.urlInput.title = buildDisplayUrl(this.parsed, this.collectionVars);
    } else {
      this.urlInput.title = "Request URL template";
    }
  }

  private onParamFieldChange(): void {
    if (this.parsed) syncPathParamsFromTemplate(this.parsed);
    this.syncUrlFromParams();
    this.refreshParamResolvedPreviews();
    this.scheduleCommit();
  }

  private refreshParamResolvedPreviews(): void {
    const vars = this.getEffectiveVars();
    if (!Object.keys(vars).length) return;
    for (const preview of Array.from(
      this.contentDiv.querySelectorAll<HTMLElement>(".bru-param-resolved"),
    )) {
      const cell = preview.closest(".bru-value-cell");
      const input = cell?.querySelector<HTMLInputElement>(".bru-field-input");
      if (!input) continue;
      const raw = input.value;
      const resolved = resolveVars(raw, vars);
      if (resolved !== raw && resolved.length > 0) {
        preview.setText(resolved);
        preview.hidden = false;
      } else {
        preview.hidden = true;
      }
    }
  }

  private renderManifestPanel(
    parsed: BruFile,
    kind: "folder" | "collection" | "environment",
  ): void {
    const panel = this.contentDiv.createDiv({ cls: "bru-manifest-panel" });

    const ymlManifest = this.isYml ? parseManifestYml(this.data) : null;
    const jsonManifest = this.brunoJsonManifest;
    const name =
      jsonManifest?.name ||
      ymlManifest?.name ||
      parsed.meta.name ||
      (kind === "collection"
        ? "Collection"
        : kind === "environment"
          ? "Environment"
          : "Folder");
    const seq = ymlManifest?.seq ?? parsed.meta.seq;
    const authType =
      ymlManifest?.authType ||
      (parsed.request.auth && parsed.request.auth !== "none"
        ? parsed.request.auth
        : "");

    panel.createEl("h2", { text: name, cls: "bru-manifest-title" });

    const descriptions: Record<typeof kind, string> = {
      folder:
        "Folder configuration for requests in this directory. Shared auth and variables apply to child requests — this file is not sent as an HTTP request.",
      collection:
        "Collection root configuration (like bruno.json or collection.bru). Auth, variables, and docs here apply to all requests in this collection — this is not an HTTP request.",
      environment:
        "Environment variables used when an environment is selected for requests in this collection.",
    };
    panel.createEl("p", { text: descriptions[kind], cls: "bru-manifest-desc" });

    const table = panel.createEl("table", { cls: "bru-manifest-table" });
    const rows: [string, string][] = [
      ["Type", kind.charAt(0).toUpperCase() + kind.slice(1)],
    ];

    if (jsonManifest?.version) rows.push(["Version", jsonManifest.version]);
    if (ymlManifest?.openCollectionVersion) {
      rows.push(["OpenCollection", ymlManifest.openCollectionVersion]);
    }
    if (ymlManifest?.bundled !== undefined) {
      rows.push(["Bundled", ymlManifest.bundled ? "true" : "false"]);
    }
    if (seq) rows.push(["Sequence", String(seq)]);
    if (authType) rows.push(["Auth", authType]);

    const vars = [...parsed.varsPreRequest, ...parsed.vars].filter(
      (entry) => entry.enabled && entry.key.trim(),
    );
    if (kind !== "environment" && vars.length > 0) rows.push(["Variables", String(vars.length)]);

    const ignore =
      jsonManifest?.ignore ??
      ymlManifest?.ignore ??
      [];
    if (ignore.length > 0) rows.push(["Ignored paths", String(ignore.length)]);

    for (const [key, value] of rows) {
      const tr = table.createEl("tr");
      tr.createEl("th", { text: key });
      tr.createEl("td", { text: value });
    }

    if (ignore.length > 0) {
      const ignoreSection = panel.createDiv({ cls: "bru-manifest-subsection" });
      ignoreSection.createEl("h3", {
        text: "Ignored paths",
        cls: "bru-manifest-subtitle",
      });
      const list = ignoreSection.createEl("ul", { cls: "bru-manifest-list" });
      for (const item of ignore) {
        list.createEl("li", { text: item });
      }
    }

    if (kind === "environment") {
      const editorSection = panel.createDiv({ cls: "bru-manifest-subsection" });
      editorSection.createEl("h3", { text: "Variables", cls: "bru-manifest-subtitle" });
      void this.renderEnvironmentEditor(editorSection);
    } else if (vars.length > 0) {
      const varsSection = panel.createDiv({ cls: "bru-manifest-subsection" });
      varsSection.createEl("h3", {
        text: "Variables",
        cls: "bru-manifest-subtitle",
      });
      const varsTable = varsSection.createEl("table", { cls: "bru-kv-table" });
      for (const entry of vars) {
        const tr = varsTable.createEl("tr");
        tr.createEl("td", { text: entry.key, cls: "bru-key" });
        const valueTd = tr.createEl("td", { cls: "bru-value" });
        this.renderValueWithVars(valueTd, entry.value);
      }
    }

    if (parsed.docs.trim()) {
      const docsSection = panel.createDiv({ cls: "bru-manifest-subsection" });
      docsSection.createEl("h3", { text: "Docs", cls: "bru-manifest-subtitle" });
      const docsBlock = docsSection.createDiv({ cls: "bru-code-block bru-manifest-docs" });
      docsBlock.setText(parsed.docs.trim());
    }
  }

  private async renderEnvironmentEditor(container: HTMLElement): Promise<void> {
    if (!this.file) return;
    const vault = this.app.vault;
    // The env file lives at <localRoot>/environments/<name>.<ext>.
    // Use the grandparent as localRoot so we resolve this specific file directly.
    const localRoot = this.file.parent?.parent?.path ?? "";
    const envName = this.file.basename;

    let state: EnvironmentVarsState;
    try {
      state = await loadEnvironmentVars(vault, localRoot, envName);
    } catch {
      container.createEl("p", { text: "Could not load environment variables.", cls: "bru-manifest-desc" });
      return;
    }

    const entries = state.entries.length > 0
      ? state.entries
      : [{ key: "", value: "", enabled: true }];

    let envSaveTimer: number | null = null;
    renderEditableKeyValueTable(container, entries, {
      keyPlaceholder: "variable",
      valuePlaceholder: "value",
      addAriaLabel: "Add variable",
      removeLabel: "Remove variable",
      showEnabledColumn: true,
      onChange: () => {
        if (envSaveTimer !== null) window.clearTimeout(envSaveTimer);
        envSaveTimer = window.setTimeout(() => {
          void saveEnvironmentVars(vault, localRoot, envName, entries, state);
          this.plugin.notifyVarsUpdated();
          envSaveTimer = null;
        }, 400);
      },
    });
  }

  private renderHeader(
    parsed: BruFile,
    filename: string,
    editable: boolean,
    manifestKind: "folder" | "collection" | "environment" | null,
  ): void {
    const isManifest = manifestKind !== null;
    const method = isManifest
      ? (manifestKind ?? "config").toUpperCase()
      : normalizeBruHttpMethod(parsed.request.method);

    const header = this.contentDiv.createDiv({ cls: "bru-header" });
    header.addClass(methodModifierClass(method));

    let methodSelect: HTMLSelectElement | null = null;

    if (editable && !isManifest) {
      methodSelect = header.createEl("select", { cls: "bru-method-select" });
      for (const option of BRU_HTTP_METHODS) {
        const opt = methodSelect.createEl("option", { text: option, value: option });
        if (option === method) opt.selected = true;
      }
      methodSelect.addEventListener("change", () => {
        parsed.request.method = normalizeBruHttpMethod(methodSelect!.value);
        const stale = Array.from(header.classList).filter(
          (cls) =>
            cls.startsWith("bru-method-") &&
            cls !== "bru-method-badge" &&
            cls !== "bru-method-select",
        );
        for (const cls of stale) header.removeClass(cls);
        header.addClass(methodModifierClass(parsed.request.method));
        this.scheduleCommit();
      });
    } else {
      header.createSpan({
        text: method,
        cls: "bru-method-badge",
      });
    }

    if (isManifest) {
      const ymlManifest = this.isYml ? parseManifestYml(this.data) : null;
      const label =
        this.brunoJsonManifest?.name ||
        ymlManifest?.name ||
        parsed.meta.name ||
        (manifestKind === "collection" ? "Collection" : "Folder");
      header.createSpan({
        text: label,
        cls: "bru-url",
      });
      return;
    }

    if (editable) {
      const urlWrap = header.createDiv({ cls: "bru-url-field-wrap" });
      const urlInput = urlWrap.createEl("input", {
        type: "text",
        cls: "bru-url-input",
        attr: {
          placeholder: "{{host}}/api/users/:id",
        },
      });
      this.urlInput = urlInput;
      urlInput.value = getTemplateUrl(parsed);
      this.syncUrlTooltip();

      urlInput.addEventListener("input", () => {
        applyTemplateUrlToParsed(parsed, urlInput.value);
        this.syncUrlTooltip();
        this.refreshParamResolvedPreviews();
        this.scheduleCommit();
      });
    } else {
      const displayUrl = buildDisplayUrl(parsed, this.collectionVars) || "(no URL)";
      header.createSpan({
        text: displayUrl,
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
      const cmd = formatBruRunCommand(
        filename,
        this.plugin.brunetSettings.activeEnvironment,
      );
      navigator.clipboard.writeText(cmd).then(() => {
        new Notice(`Copied: ${cmd}`);
      }).catch(() => {
        new Notice(cmd);
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

      this.runWithCollectionVars().then((result) => {
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
    this.destroyConsoleEditors();
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

    container.createDiv({
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
    line.createSpan({
      text: method,
      cls: `bru-method-badge ${methodModifierClass(method)}`,
    });
    line.createSpan({ text: req.url || "(no URL)", cls: "bru-console-url" });

    const headerEntries = Object.entries(req.headers);
    if (headerEntries.length > 0) {
      const headersDetails = container.createEl("details", { cls: "bru-section" });
      headersDetails.open = true;
      const headersSummary = headersDetails.createEl("summary");
      headersSummary.createSpan( { text: "Headers" });
      headersSummary.createSpan( {
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
      bodySummary.createSpan( { text: "Body" });
      bodySummary.createSpan( {
        text: `${req.body.length} chars`,
        cls: "bru-section-count",
      });
      const bodyContent = bodyDetails.createDiv({ cls: "bru-section-body" });
      const bodyType = this.parsed?.bodyType
        ? normalizeBodyType(this.parsed.bodyType)
        : inferBodyTypeFromHeaders(req.headers, req.body);
      this.mountConsoleBodyViewer(bodyContent, req.body, bodyType);
    }
  }

  private renderResponseInto(container: HTMLElement, resp: BruResponse): void {
    const statusRow = container.createDiv({ cls: "bru-res-status-row" });

    statusRow.createSpan({
      text: resp.status ? String(resp.status) : "ERR",
      cls: `bru-res-badge ${statusBadgeClass(resp.status)}`,
    });

    statusRow.createSpan({ text: resp.statusText });

    statusRow.createSpan( {
      text: `${resp.durationMs} ms`,
      cls: "bru-res-duration",
    });

    if (resp.error) {
      container.createDiv({
        text: resp.error,
        cls: "bru-res-error",
      });
    }

    const headerEntries = Object.entries(resp.headers ?? {});
    if (headerEntries.length > 0) {
      const headersDetails = container.createEl("details", { cls: "bru-section" });
      const headersSummary = headersDetails.createEl("summary");
      headersSummary.createSpan( { text: "Response Headers" });
      headersSummary.createSpan( {
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
      bodySummary.createSpan( { text: "Response Body" });

      const bodyLength = resp.body ? resp.body.length : 0;
      const note = resp.json !== null ? "JSON" : `${bodyLength} chars`;
      bodySummary.createSpan( { text: note, cls: "bru-section-count" });

      const bodyContent = bodyDetails.createDiv({ cls: "bru-section-body" });
      const responseText =
        resp.json !== null ? JSON.stringify(resp.json, null, 2) : resp.body;
      const bodyType =
        resp.json !== null
          ? "json"
          : inferBodyTypeFromHeaders(resp.headers ?? {}, responseText);
      this.mountConsoleBodyViewer(bodyContent, responseText, bodyType);
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

    const envPanel = this.createTab(tabNav, holder, "environment", "Environment");
    this.envPanel = envPanel;
    void this.mountEnvironmentTab(envPanel);

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
      container.createEl("p", {
        cls: "bru-params-hint",
        text:
          "Use :name in the URL for path params. Query params are appended to the resolved URL when enabled. Values support {{variables}} from the active environment.",
      });

      const pathGroup = container.createDiv({ cls: "bru-param-group" });
      pathGroup.createEl("h4", { text: "Path Parameters", cls: "bru-param-heading" });
      this.renderEditableKeyValues(pathGroup, parsed.path, {
        keyPlaceholder: "name",
        valuePlaceholder: "value or {{variable}}",
        addAriaLabel: "Add path parameter",
        removeLabel: "Remove path parameter",
        reflectInUrl: true,
        syncPathKeysInUrl: true,
      });

      const queryGroup = container.createDiv({ cls: "bru-param-group" });
      queryGroup.createEl("h4", { text: "Query Parameters", cls: "bru-param-heading" });
      this.renderEditableKeyValues(queryGroup, parsed.query, {
        keyPlaceholder: "name",
        valuePlaceholder: "value or {{variable}}",
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
      this.renderResolvedKeyValueTable(pathGroup, pathEntries);
    }

    if (queryEntries.length) {
      const queryGroup = container.createDiv({ cls: "bru-param-group" });
      queryGroup.createEl("h4", { text: "Query Parameters", cls: "bru-param-heading" });
      this.renderResolvedKeyValueTable(queryGroup, queryEntries);
    }
  }

  /** Read-only params table with resolved values (Bruno/Postman preview). */
  private renderResolvedKeyValueTable(
    container: HTMLElement,
    entries: BruKeyValue[],
  ): void {
    const table = container.createEl("table", { cls: "bru-kv-table" });
    for (const entry of entries) {
      const tr = table.createEl("tr");
      if (!entry.enabled) tr.addClass("bru-disabled");
      const keyTd = tr.createEl("td", { cls: "bru-key" });
      this.renderValueWithVars(keyTd, entry.key);
      const valueTd = tr.createEl("td", { cls: "bru-value" });
      this.renderValueWithVars(valueTd, entry.value);
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
    if (parsed.request.body) rows.push(["body mode", parsed.request.body]);
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
      showEnabledColumn?: boolean;
      syncPathKeysInUrl?: boolean;
    },
  ): void {
    const onFieldChange = opts.reflectInUrl
      ? () => this.onParamFieldChange()
      : () => this.scheduleCommit();
    const resolveValue = (raw: string) =>
      resolveVars(raw, this.getEffectiveVars());
    renderEditableKeyValueTable(container, entries, {
      keyPlaceholder: opts.keyPlaceholder,
      valuePlaceholder: opts.valuePlaceholder,
      addAriaLabel: opts.addAriaLabel,
      removeLabel: opts.removeLabel,
      showEnabledColumn: opts.showEnabledColumn,
      resolveDisplayValue: resolveValue,
      onKeyChange:
        opts.syncPathKeysInUrl && this.parsed
          ? (entry, previousKey) => {
              if (previousKey.trim() && entry.key.trim()) {
                renamePathParamInUrl(this.parsed!, previousKey, entry.key);
              }
            }
          : undefined,
      onChange: onFieldChange,
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
    const bodyContent = getBruBodyContent(parsed);
    const resolvedType = normalizeBodyType(
      getBruBodyType(parsed) || inferBodyType(bodyContent),
    );
    parsed.bodyType = resolvedType;

    if (!editable) {
      if (!bodyContent.trim()) {
        container.createEl("p", { text: "No body.", cls: "bru-tab-empty" });
        return;
      }
      if (isFormBodyType(resolvedType)) {
        const entries = parseFormBodyContent(bodyContent);
        if (entries.length) {
          this.renderKeyValueTable(container, entries);
        } else {
          container.createEl("p", { text: "No body.", cls: "bru-tab-empty" });
        }
        return;
      }
      const code = container.createDiv({ cls: "bru-code-block" });
      this.renderValueWithVars(code, bodyContent.trim());
      return;
    }

    if (isFormBodyType(resolvedType)) {
      this.renderFormBodyEditor(container, parsed, bodyContent);
      return;
    }

    container.empty();
    container.addClass("bru-body-tab-content");

    const toolbar = container.createDiv({ cls: "bru-body-editor-toolbar" });
    const typeWrap = toolbar.createDiv({ cls: "bru-body-type-wrap" });
    typeWrap.createSpan({ text: "Type", cls: "bru-body-type-label" });

    let typeSelect: HTMLSelectElement;
    typeSelect = typeWrap.createEl("select", { cls: "bru-body-type-select" });
    for (const option of BODY_TYPE_OPTIONS) {
      const opt = typeSelect.createEl("option", {
        text: bodyTypeSelectLabel(option),
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

    const editorHost = container.createDiv({ cls: "bru-body-editor-host" });

    const syncToolbarForBodyType = (bodyType: string) => {
      const structured = canPrettifyBody(bodyType);
      prettifyBtn.hidden = !structured;
      collapseAllBtn.hidden = !canFoldBody(bodyType);
      expandAllBtn.hidden = !canFoldBody(bodyType);
    };

    const mountEditor = () => {
      this.destroyBodyEditor();
      editorHost.empty();
      const bodyType = normalizeBodyType(parsed.bodyType);
      syncToolbarForBodyType(bodyType);
      this.bodyEditor = createBodyEditor(
        editorHost,
        parsed.body || bodyContent,
        bodyType,
        (value) => {
          parsed.body = value;
          parsed.request.body = parsed.bodyType || "json";
          this.scheduleCommit();
        },
      );
    };

    syncToolbarForBodyType(parsed.bodyType);
    mountEditor();

    typeSelect.addEventListener("change", () => {
      const nextType = normalizeBodyType(typeSelect.value);
      parsed.bodyType = nextType;
      parsed.request.body = nextType;
      if (isFormBodyType(nextType)) {
        this.renderFormBodyEditor(container, parsed, parsed.body);
        this.scheduleCommit();
        return;
      }
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
  }

  private renderFormBodyEditor(
    container: HTMLElement,
    parsed: BruFile,
    bodyContent: string,
  ): void {
    this.destroyBodyEditor();
    container.empty();
    container.addClass("bru-body-tab-content");

    const entries = parseFormBodyContent(bodyContent);
    if (!entries.length) {
      entries.push({ key: "", value: "", enabled: true });
    }

    const toolbar = container.createDiv({ cls: "bru-body-editor-toolbar" });
    const typeWrap = toolbar.createDiv({ cls: "bru-body-type-wrap" });
    typeWrap.createSpan({ text: "Type", cls: "bru-body-type-label" });

    const typeSelect = typeWrap.createEl("select", { cls: "bru-body-type-select" });
    for (const option of BODY_TYPE_OPTIONS) {
      const opt = typeSelect.createEl("option", {
        text: bodyTypeSelectLabel(option),
        value: option,
      });
      if (option === normalizeBodyType(parsed.bodyType)) {
        opt.selected = true;
      }
    }

    const formHost = container.createDiv({ cls: "bru-body-form-host" });

    const mountForm = () => {
      formHost.empty();
      renderEditableKeyValueTable(formHost, entries, {
        keyPlaceholder: "Field name",
        valuePlaceholder: "Value",
        addAriaLabel: "Add field",
        removeLabel: "Remove field",
        onChange: () => {
          parsed.body = serializeFormBodyContent(entries);
          parsed.request.body = parsed.bodyType;
          this.scheduleCommit();
        },
      });
    };

    mountForm();

    typeSelect.addEventListener("change", () => {
      parsed.bodyType = normalizeBodyType(typeSelect.value);
      parsed.request.body = parsed.bodyType;
      if (isFormBodyType(parsed.bodyType)) {
        mountForm();
      } else {
        this.renderBodyInto(container, parsed, true);
      }
      this.scheduleCommit();
    });
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
        valueTd.createSpan( {
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
    body.createDiv({
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
    });
    details.open = title !== "Raw Source"; // open all except raw

    const summary = details.createEl("summary");
    if (icon) {
      summary.createSpan( { text: icon + " ", cls: "bru-section-icon" });
    }
    summary.createSpan( { text: title });
    if (count > 0) {
      summary.createSpan( {
        text: `${count}`,
        cls: "bru-section-count",
      });
    }

    return details;
  }

  /**
   * Renders a text value, substituting known {{variable}} refs from the active
   * environment/collection and highlighting any that remain unresolved.
   */
  private renderValueWithVars(container: HTMLElement, text: string): void {
    const resolved = resolveVars(text, this.getEffectiveVars());
    const parts = resolved.split(/({{[^}]*}})/g);
    for (const part of parts) {
      if (part.startsWith("{{") && part.endsWith("}}")) {
        container.createSpan( { text: part, cls: "bru-var-ref" });
      } else {
        container.appendText(part);
      }
    }
  }

}
