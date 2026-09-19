/**
 * Brunet right sidebar — Mermaid flow editor for sequential .bru / .yml requests.
 */

import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import {
  createDefaultFlow,
  listRunnableRequestFiles,
  runFlow,
  type Flow,
  type FlowStepOutcome,
  type RunnableRequestFile,
} from "./bruFlow";
import {
  buildSampleMermaid,
  describeMermaidSyntax,
  ensureFlowMermaid,
  highlightRunState,
  renderMermaidDiagram,
  syncFlowFromMermaid,
} from "./bruFlowMermaid";
import {
  FEATURE_FLAGS,
  GITHUB_NEW_ISSUE_URL,
  GITHUB_REPO_URL,
} from "./featureFlags";
import type BrunetPlugin from "./main";

export const SERVICE_VIEW_TYPE = "brunet-service";

const DIAGRAM_ZOOM_MIN = 0.25;
const DIAGRAM_ZOOM_MAX = 2.5;
const DIAGRAM_ZOOM_STEP = 0.15;

export class ServiceView extends ItemView {
  private selectedFlowId: string | null = null;
  private requestFiles: RunnableRequestFile[] = [];
  private running = false;
  private mermaidRenderTimer: number | null = null;
  private diagramHost: HTMLElement | null = null;
  private diagramRenderGen = 0;
  private diagramZoom = 1;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: BrunetPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return SERVICE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Brunet Flow";
  }

  getIcon(): string {
    return "dog";
  }

  async onOpen(): Promise<void> {
    this.registerEvent(this.app.vault.on("create", () => void this.refresh()));
    this.registerEvent(this.app.vault.on("delete", () => void this.refresh()));
    this.registerEvent(this.app.vault.on("rename", () => void this.refresh()));
    this.register(this.plugin.onEnvironmentChange(() => void this.refresh()));
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!FEATURE_FLAGS.FLOW_PANEL) {
      this.render();
      return;
    }

    this.requestFiles = await listRunnableRequestFiles(this.app.vault);
    for (const flow of this.plugin.brunetSettings.flows) {
      ensureFlowMermaid(flow);
      syncFlowFromMermaid(flow, this.requestFiles);
    }
    const flows = this.plugin.brunetSettings.flows;
    if (flows.length && !this.selectedFlowId) {
      this.selectedFlowId = flows[0].id;
    }
    if (
      this.selectedFlowId &&
      !flows.some((f) => f.id === this.selectedFlowId)
    ) {
      this.selectedFlowId = flows[0]?.id ?? null;
    }
    this.render();
  }

  private render(): void {
    if (this.mermaidRenderTimer !== null) {
      window.clearTimeout(this.mermaidRenderTimer);
      this.mermaidRenderTimer = null;
    }
    this.diagramRenderGen++;
    this.diagramHost = null;


    const contentArea = this.contentEl;
    contentArea.empty();

    if (!FEATURE_FLAGS.FLOW_PANEL) {
      this.renderComingSoon(contentArea);
      return;
    }

    const root = contentArea.createDiv({ cls: "brunet-flow-root" });

    const header = root.createDiv({ cls: "brunet-flow-header" });
    header.createSpan({ text: "Flows", cls: "brunet-flow-title" });
    const headerActions = header.createDiv({ cls: "brunet-flow-header-actions" });
    const sampleBtn = headerActions.createEl("button", {
      text: "Sample",
      cls: "brunet-flow-btn",
    });
    sampleBtn.addEventListener("click", () => void this.addFlowWithSample());
    const newBtn = headerActions.createEl("button", {
      text: "+ New",
      cls: "brunet-flow-btn brunet-flow-btn-accent",
    });
    newBtn.addEventListener("click", () => void this.addFlow());

    const flows = this.plugin.brunetSettings.flows;

    if (flows.length === 0) {
      const empty = root.createDiv({ cls: "brunet-flow-empty" });
      empty.createEl("p", {
        text: "Define API sequences as a Mermaid flowchart.",
      });
      empty.createEl("pre", {
        text: describeMermaidSyntax(),
        cls: "brunet-flow-syntax-sample",
      });
      const emptyActions = empty.createDiv({ cls: "brunet-flow-empty-actions" });
      emptyActions.createEl("button", {
        text: "Create sample flow",
        cls: "brunet-flow-btn brunet-flow-btn-accent",
      }).addEventListener("click", () => void this.addFlowWithSample());
      return;
    }

    const tabs = root.createDiv({ cls: "brunet-flow-tabs" });
    for (const flow of flows) {
      const tab = tabs.createEl("button", {
        text: flow.name,
        cls: "brunet-flow-tab",
      });
      if (flow.id === this.selectedFlowId) {
        tab.classList.add("brunet-flow-tab-active");
      }
      tab.addEventListener("click", () => {
        this.selectedFlowId = flow.id;
        this.render();
      });
    }

    const selected = flows.find((f) => f.id === this.selectedFlowId);
    if (!selected) return;

    this.renderFlowEditor(root, selected);
  }

  private renderComingSoon(contentArea: HTMLElement): void {
    const wrap = contentArea.createDiv({ cls: "brunet-flow-coming-soon" });

    const iconWrap = wrap.createDiv({ cls: "brunet-flow-coming-soon-icon" });
    setIcon(iconWrap, "eye");

    wrap.createEl("h3", {
      text: "Flow",
      cls: "brunet-flow-coming-soon-title",
    });

    wrap.createEl("p", {
      cls: "brunet-flow-coming-soon-lead",
      text: "Mermaid API flows — sequences, branches, and loops — are still under active development.",
    });

    wrap.createEl("p", {
      cls: "brunet-flow-coming-soon-detail",
      text: "The full flow builder is hidden while we stabilize branching, conditions, and run behavior.",
    });

    const actions = wrap.createDiv({ cls: "brunet-flow-coming-soon-actions" });

    const issueLink = actions.createEl("a", {
      cls: "brunet-flow-coming-soon-link",
      text: "Open a GitHub issue",
      href: GITHUB_NEW_ISSUE_URL,
    });
    issueLink.target = "_blank";
    issueLink.rel = "noopener noreferrer";

    actions.createSpan({
      cls: "brunet-flow-coming-soon-sep",
      text: "·",
    });

    const repoLink = actions.createEl("a", {
      cls: "brunet-flow-coming-soon-link",
      text: "View repo",
      href: GITHUB_REPO_URL,
    });
    repoLink.target = "_blank";
    repoLink.rel = "noopener noreferrer";
  }

  private renderFlowEditor(parent: HTMLElement, flow: Flow): void {
    ensureFlowMermaid(flow);
    const parseErrors = syncFlowFromMermaid(flow, this.requestFiles);

    const editor = parent.createDiv({ cls: "brunet-flow-editor" });

    const toolbar = editor.createDiv({ cls: "brunet-flow-toolbar" });
    const nameInput = toolbar.createEl("input", {
      type: "text",
      cls: "brunet-flow-name-input",
    });
    nameInput.value = flow.name;
    nameInput.placeholder = "Flow name";
    nameInput.addEventListener("change", () => {
      flow.name = nameInput.value.trim() || "Untitled flow";
      void this.persistFlows();
    });

    const runBtn = toolbar.createEl("button", {
      text: "▶ Run",
      cls: "brunet-flow-btn brunet-flow-btn-run",
    });
    runBtn.disabled = this.running || flow.steps.length === 0;
    runBtn.addEventListener("click", () => void this.runSelectedFlow(flow, runBtn));

    const deleteBtn = toolbar.createEl("button", {
      text: "Delete",
      cls: "brunet-flow-btn brunet-flow-btn-danger",
    });
    deleteBtn.addEventListener("click", () => void this.deleteFlow(flow.id));

    const options = editor.createDiv({ cls: "brunet-flow-options" });
    const stopLabel = options.createEl("label", { cls: "brunet-flow-checkbox" });
    const stopCheck = stopLabel.createEl("input", { type: "checkbox" });
    stopCheck.checked = flow.stopOnError;
    stopLabel.createSpan({ text: " Stop on error (non-2xx or network failure)" });
    stopCheck.addEventListener("change", () => {
      flow.stopOnError = stopCheck.checked;
      void this.persistFlows();
    });

    const mermaidSection = editor.createDiv({ cls: "brunet-flow-mermaid-section" });
    const mermaidHeader = mermaidSection.createDiv({ cls: "brunet-flow-mermaid-header" });
    mermaidHeader.createSpan({
      text: "Mermaid",
      cls: "brunet-flow-section-title",
    });
    const insertSampleBtn = mermaidHeader.createEl("button", {
      text: "Sample",
      cls: "brunet-flow-btn",
    });
    insertSampleBtn.addEventListener("click", () => {
      this.applySampleToFlow(flow);
      this.render();
    });

    mermaidSection.createEl("p", {
      cls: "brunet-flow-mermaid-hint",
      text: "Request s0[\"file.bru\"] · branch c0{s0.status eq 200} with |yes|/|no| · loop s_page -->|loop max 3| s_page",
    });

    const errorHost = mermaidSection.createDiv({ cls: "brunet-flow-parse-errors" });
    this.renderParseErrors(errorHost, parseErrors);

    const textarea = mermaidSection.createEl("textarea", {
      cls: "brunet-flow-mermaid-input",
      text: flow.mermaid,
    });
    textarea.spellcheck = false;
    textarea.rows = 8;

    const diagramPanel = mermaidSection.createDiv({
      cls: "brunet-flow-mermaid-diagram",
    });
    const zoomBar = diagramPanel.createDiv({ cls: "brunet-flow-mermaid-zoom" });
    const diagramViewport = diagramPanel.createDiv({
      cls: "brunet-flow-mermaid-viewport",
    });
    this.diagramHost = diagramViewport;
    this.mountDiagramZoomControls(zoomBar, diagramViewport);
    const diagramGen = this.diagramRenderGen;

    const scheduleDiagramRender = () => {
      if (this.mermaidRenderTimer !== null) {
        window.clearTimeout(this.mermaidRenderTimer);
      }
      this.mermaidRenderTimer = window.setTimeout(() => {
        void this.renderDiagram(
          diagramViewport,
          textarea.value,
          errorHost,
          flow,
          diagramGen,
        );
      }, 350);
    };

    textarea.addEventListener("input", () => {
      flow.mermaid = textarea.value;
      const errors = syncFlowFromMermaid(flow, this.requestFiles);
      this.renderParseErrors(errorHost, errors);
      runBtn.disabled = this.running || flow.steps.length === 0;
      scheduleDiagramRender();
    });

    textarea.addEventListener("change", () => {
      void this.persistFlows();
    });

    void this.renderDiagram(
      diagramViewport,
      flow.mermaid,
      errorHost,
      flow,
      diagramGen,
    );

    const filesHint = editor.createDiv({ cls: "brunet-flow-files-hint" });
    if (this.requestFiles.length === 0) {
      filesHint.createEl("p", {
        text: "No runnable .bru or .yml files found in vault.",
        cls: "brunet-flow-files-empty",
      });
    } else {
      filesHint.createSpan({
        text: "Available: ",
        cls: "brunet-flow-files-label",
      });
      const list = filesHint.createSpan({ cls: "brunet-flow-files-list" });
      list.textContent = this.requestFiles
        .slice(0, 8)
        .map((f) => f.path)
        .join(", ");
      if (this.requestFiles.length > 8) {
        list.textContent += ` … (+${this.requestFiles.length - 8} more)`;
      }
    }

    const logHost = editor.createDiv({ cls: "brunet-flow-log-host" });
    logHost.setAttribute("data-flow-log", flow.id);
  }

  private renderParseErrors(host: HTMLElement, errors: string[]): void {
    host.empty();
    if (errors.length === 0) return;
    for (const err of errors) {
      host.createEl("p", { text: err, cls: "brunet-flow-parse-error" });
    }
  }

  private clampDiagramZoom(value: number): number {
    return Math.min(DIAGRAM_ZOOM_MAX, Math.max(DIAGRAM_ZOOM_MIN, value));
  }

  private formatDiagramZoomLabel(): string {
    return `${Math.round(this.diagramZoom * 100)}%`;
  }

  private applyDiagramZoom(viewport: HTMLElement): void {
    const svgWrap = viewport.querySelector<HTMLElement>(
      ".brunet-flow-mermaid-svg",
    );
    if (svgWrap) {
      svgWrap.setCssProps({ "--brunet-diagram-zoom": String(this.diagramZoom) });
    }

    const panel = viewport.closest(".brunet-flow-mermaid-diagram");
    const label = panel?.querySelector(".brunet-flow-zoom-label");
    if (label) {
      label.textContent = this.formatDiagramZoomLabel();
    }
  }

  private mountDiagramZoomControls(
    bar: HTMLElement,
    viewport: HTMLElement,
  ): void {
    bar.createSpan({
      text: "Zoom",
      cls: "brunet-flow-zoom-title",
    });

    const minusBtn = bar.createEl("button", {
      text: "−",
      cls: "brunet-flow-icon-btn",
      attr: { "aria-label": "Zoom out" },
    });
    const zoomLabel = bar.createSpan({
      text: this.formatDiagramZoomLabel(),
      cls: "brunet-flow-zoom-label",
    });
    const plusBtn = bar.createEl("button", {
      text: "+",
      cls: "brunet-flow-icon-btn",
      attr: { "aria-label": "Zoom in" },
    });
    const resetBtn = bar.createEl("button", {
      text: "Reset",
      cls: "brunet-flow-btn brunet-flow-zoom-reset",
    });

    const setZoom = (value: number) => {
      this.diagramZoom = this.clampDiagramZoom(value);
      zoomLabel.textContent = this.formatDiagramZoomLabel();
      this.applyDiagramZoom(viewport);
    };

    minusBtn.addEventListener("click", () => {
      setZoom(this.diagramZoom - DIAGRAM_ZOOM_STEP);
    });
    plusBtn.addEventListener("click", () => {
      setZoom(this.diagramZoom + DIAGRAM_ZOOM_STEP);
    });
    resetBtn.addEventListener("click", () => {
      setZoom(1);
    });

    viewport.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        const delta = e.deltaY > 0 ? -DIAGRAM_ZOOM_STEP : DIAGRAM_ZOOM_STEP;
        setZoom(this.diagramZoom + delta);
      },
      { passive: false },
    );
  }

  private async renderDiagram(
    host: HTMLElement,
    source: string,
    errorHost: HTMLElement,
    flow: Flow,
    renderGen: number,
  ): Promise<void> {
    if (!source.trim()) return;
    if (renderGen !== this.diagramRenderGen || !host.isConnected) return;

    await renderMermaidDiagram(host, source);

    if (renderGen !== this.diagramRenderGen || !host.isConnected) return;

    this.applyDiagramZoom(host);

    const errors = syncFlowFromMermaid(flow, this.requestFiles);
    this.renderParseErrors(errorHost, errors);
  }

  private applySampleToFlow(flow: Flow): void {
    flow.mermaid = buildSampleMermaid(this.requestFiles);
    syncFlowFromMermaid(flow, this.requestFiles);
    void this.persistFlows();
  }

  private async addFlowWithSample(): Promise<void> {
    await this.addFlow("Sample flow");
  }

  private async addFlow(name?: string): Promise<void> {
    const flow = createDefaultFlow(
      name ?? `Flow ${this.plugin.brunetSettings.flows.length + 1}`,
    );
    this.applySampleToFlow(flow);
    this.plugin.brunetSettings.flows.push(flow);
    this.selectedFlowId = flow.id;
    await this.persistFlows();
    this.render();
  }

  private async deleteFlow(flowId: string): Promise<void> {
    this.plugin.brunetSettings.flows = this.plugin.brunetSettings.flows.filter(
      (f) => f.id !== flowId,
    );
    if (this.selectedFlowId === flowId) {
      this.selectedFlowId = this.plugin.brunetSettings.flows[0]?.id ?? null;
    }
    await this.persistFlows();
    this.render();
  }

  private async persistFlows(): Promise<void> {
    await this.plugin.saveSettings();
  }

  private async runSelectedFlow(
    flow: Flow,
    runBtn: HTMLButtonElement,
  ): Promise<void> {
    if (this.running) return;

    const textarea = this.contentEl.querySelector<HTMLTextAreaElement>(
      ".brunet-flow-mermaid-input",
    );
    if (textarea) {
      flow.mermaid = textarea.value;
    }

    const errors = syncFlowFromMermaid(flow, this.requestFiles);
    if (errors.length > 0 || flow.steps.length === 0) return;

    const missing = flow.steps.some((s) => !s.filePath);
    if (missing) return;

    this.running = true;
    runBtn.disabled = true;
    runBtn.textContent = "Running…";

    const logHost = this.contentEl.querySelector<HTMLElement>(
      `[data-flow-log="${flow.id}"]`,
    );
    if (logHost) {
      logHost.empty();
      logHost.createDiv({
        text: "Running flow…",
        cls: "brunet-flow-log-title",
      });
    }

    const logEntries: HTMLElement[] = [];
    const runHighlights: Array<{
      index: number;
      skipped: boolean;
      status?: number;
    }> = [];

    const appendLog = (outcome: FlowStepOutcome) => {
      runHighlights.push({
        index: outcome.index,
        skipped: outcome.skipped,
        status: outcome.result?.response.status,
      });
      if (this.diagramHost) {
        highlightRunState(this.diagramHost, runHighlights);
      }
      if (!logHost) return;
      const entry = logHost.createDiv({ cls: "brunet-flow-log-entry" });
      logEntries.push(entry);
      this.renderLogEntry(entry, outcome);
    };

    try {
      const result = await runFlow(
        flow,
        this.app.vault,
        this.plugin.brunetSettings.activeEnvironment,
        appendLog,
      );

      if (logHost && result.stopped && result.stopReason) {
        logHost.createDiv({
          cls: "brunet-flow-log-stopped",
          text: `Stopped: ${result.stopReason}`,
        });
      } else if (logHost && logEntries.length === 0) {
        logHost.createDiv({
          cls: "brunet-flow-log-stopped",
          text: "No steps executed.",
        });
      }
    } finally {
      this.running = false;
      runBtn.disabled = flow.steps.length === 0;
      runBtn.textContent = "▶ Run";
    }
  }

  private renderLogEntry(entry: HTMLElement, outcome: FlowStepOutcome): void {
    const label =
      outcome.step.label ??
      outcome.step.filePath.split("/").pop() ??
      `Step ${outcome.index + 1}`;

    const head = entry.createDiv({ cls: "brunet-flow-log-head" });
    head.createSpan({
      text: `${outcome.index + 1}. ${label}`,
      cls: "brunet-flow-log-label",
    });

    if (outcome.skipped) {
      entry.classList.add("brunet-flow-log-skipped");
      head.createSpan({
        text: "SKIPPED",
        cls: "brunet-flow-log-badge brunet-flow-log-badge-muted",
      });
      if (outcome.skipReason) {
        entry.createEl("p", {
          text: outcome.skipReason,
          cls: "brunet-flow-log-detail",
        });
      }
      return;
    }

    const resp = outcome.result!.response;
    const ok = resp.status >= 200 && resp.status < 300;
    head.createSpan({
      text: resp.status ? String(resp.status) : "ERR",
      cls: `brunet-flow-log-badge ${ok ? "brunet-flow-log-badge-ok" : "brunet-flow-log-badge-err"}`,
    });
    head.createSpan({
      text: `${resp.durationMs}ms`,
      cls: "brunet-flow-log-duration",
    });

    if (resp.error) {
      entry.createEl("p", {
        text: resp.error,
        cls: "brunet-flow-log-detail brunet-flow-log-error",
      });
    } else if (resp.body) {
      const preview = resp.body.length > 200
        ? `${resp.body.slice(0, 200)}…`
        : resp.body;
      entry.createEl("pre", {
        text: preview,
        cls: "brunet-flow-log-body",
      });
    }
  }

}
