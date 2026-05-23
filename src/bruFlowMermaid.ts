/**
 * Mermaid flowchart format for Brunet flows.
 *
 * Request:  s0[".../albums/Get Album by ID.bru"]
 * Condition: c0{s0.status eq 200}
 * Success:   s_ok on |yes| · s_err (GraphQL) on |no|
 *
 * Edges:
 *   s0 --> c0
 *   c0 -->|yes| s_ok
 *   c0 -->|no| s_err
 *   s_page -->|loop max 3| s_page
 *   s_page -->|done| s_done
 */

import mermaid from "mermaid";
import {
  createFlowStepId,
  describeFlowCondition,
  type Flow,
  type FlowCondition,
  type FlowConditionField,
  type FlowConditionOperator,
  type FlowGraph,
  type FlowGraphEdge,
  type FlowGraphNode,
  type FlowNodeType,
  type FlowStep,
  type RunnableRequestFile,
} from "./bruFlow";

function pickFile(
  requestFiles: RunnableRequestFile[],
  index: number,
  fallback: string,
): string {
  return requestFiles[index]?.path ?? fallback;
}

function findFileByPattern(
  requestFiles: RunnableRequestFile[],
  patterns: RegExp[],
  exclude: Set<string>,
): string | undefined {
  for (const file of requestFiles) {
    if (exclude.has(file.path)) continue;
    const haystack = `${file.path} ${file.name}`.toLowerCase();
    if (patterns.some((p) => p.test(haystack))) return file.path;
  }
  return undefined;
}

/** Default sample paths (JSONPlaceholder-style collection). */
const SAMPLE_FALLBACK_PATHS = {
  s0: "bruno/JSONPlaceholder Sample (Bru)/albums/Get Album by ID.bru",
  s_ok: "bruno/JSONPlaceholder Sample (Bru)/users/Get All Users.bru",
  s_err: "bruno/JSONPlaceholder Sample (Bru)/body-types/Body GraphQL.bru",
  s_page: "bruno/JSONPlaceholder Sample (Bru)/body-types/Body Form URL Encoded.bru",
  s_done: "bruno/JSONPlaceholder Sample (Bru)/posts/Delete Post.bru",
};

/** Map vault files to sample roles (album → s0, graphql → s_err, …). */
function assignSampleFiles(requestFiles: RunnableRequestFile[]): {
  s0: string;
  s_ok: string;
  s_err: string;
  s_page: string;
  s_done: string;
} {
  if (requestFiles.length === 0) return { ...SAMPLE_FALLBACK_PATHS };

  const used = new Set<string>();

  const take = (
    patterns: RegExp[],
    fallbackIndex: number,
    key: keyof typeof SAMPLE_FALLBACK_PATHS,
  ): string => {
    const matched = findFileByPattern(requestFiles, patterns, used);
    const path =
      matched ??
      pickFile(requestFiles, fallbackIndex, SAMPLE_FALLBACK_PATHS[key]);
    used.add(path);
    return path;
  };

  return {
    s0: take(
      [/get album by id/i, /albums\/.*id/i, /album/i, /login/i, /auth/i],
      0,
      "s0",
    ),
    s_ok: take(
      [/get all users/i, /users\/get/i, /users/i, /profile/i, /user/i],
      1,
      "s_ok",
    ),
    s_err: take(
      [/body graphql/i, /graphql/i, /error/i, /fail/i, /invalid/i],
      3,
      "s_err",
    ),
    s_page: take(
      [/form url encoded/i, /body form/i, /form-urlencoded/i, /page/i, /list/i],
      2,
      "s_page",
    ),
    s_done: take(
      [/delete post/i, /posts\/delete/i, /delete/i, /logout/i, /done/i],
      4,
      "s_done",
    ),
  };
}

function buildSampleMermaidSource(paths: {
  s0: string;
  s_ok: string;
  s_err: string;
  s_page: string;
  s_done: string;
}): string {
  return [
    "flowchart TD",
    "    %% 1) Run s0 · 2) c0 branches on s0.status · 3) loop s_page on |yes| path",
    `    s0["${escapeMermaidLabel(paths.s0)}"]`,
    "    c0{s0.status eq 200}",
    `    s_ok["${escapeMermaidLabel(paths.s_ok)}"]`,
    `    s_err["${escapeMermaidLabel(paths.s_err)}"]`,
    `    s_page["${escapeMermaidLabel(paths.s_page)}"]`,
    `    s_done["${escapeMermaidLabel(paths.s_done)}"]`,
    "    s0 --> c0",
    "    c0 -->|yes| s_ok",
    "    c0 -->|no| s_err",
    "    s_ok --> s_page",
    "    s_page -->|loop max 3| s_page",
    "    s_page -->|done| s_done",
    "    s_err --> s_done",
  ].join("\n");
}

const DEFAULT_MERMAID = buildSampleMermaidSource(SAMPLE_FALLBACK_PATHS);

export interface MermaidParseResult {
  steps: FlowStep[];
  graph: FlowGraph;
  errors: string[];
}

let mermaidReady = false;

function escapeMermaidLabel(text: string): string {
  return text.replace(/"/g, "#quot;");
}

function unescapeMermaidLabel(text: string): string {
  return text.replace(/#quot;/g, '"');
}

function operatorLabel(op: FlowConditionOperator): string {
  return op;
}

function parseConditionText(raw: string): FlowCondition | undefined {
  const trimmed = raw.trim().replace(/\?$/, "");
  if (!trimmed) return undefined;

  const withIf = trimmed.match(/^if:\s*(.+)$/i);
  const body = withIf ? withIf[1].trim() : trimmed;

  const conditionPattern =
    /^(status|body|json(?:\.[\w.]+)?)\s+(eq|neq|gt|gte|lt|lte|contains|not_contains)\s+(.+)$/i;

  const stepMatch = body.match(/^step(\d+)\.(.+)$/i);
  if (stepMatch) {
    const fieldMatch = stepMatch[2].match(conditionPattern);
    if (!fieldMatch) return undefined;
    return buildFlowCondition(
      Number(stepMatch[1]),
      undefined,
      fieldMatch[1],
      fieldMatch[2] as FlowConditionOperator,
      fieldMatch[3],
    );
  }

  const nodeMatch = body.match(/^([a-zA-Z_]\w*)\.(.+)$/i);
  if (nodeMatch) {
    const fieldMatch = nodeMatch[2].match(conditionPattern);
    if (!fieldMatch) return undefined;
    const nodeId = nodeMatch[1];
    const stepNum = /^s(\d+)$/.exec(nodeId);
    return buildFlowCondition(
      stepNum ? Number(stepNum[1]) : 0,
      nodeId,
      fieldMatch[1],
      fieldMatch[2] as FlowConditionOperator,
      fieldMatch[3],
    );
  }

  return undefined;
}

function buildFlowCondition(
  fromStep: number,
  fromNodeId: string | undefined,
  fieldRaw: string,
  operator: FlowConditionOperator,
  value: string,
): FlowCondition {
  const fieldLower = fieldRaw.toLowerCase();
  if (fieldLower.startsWith("json.")) {
    return {
      fromStep,
      fromNodeId,
      field: "json",
      jsonPath: fieldLower.slice("json.".length),
      operator,
      value: value.trim(),
    };
  }

  return {
    fromStep,
    fromNodeId,
    field: fieldLower as FlowConditionField,
    operator,
    value: value.trim(),
  };
}

function parseLoopMeta(text: string): {
  loopMax?: number;
  loopWhile?: FlowCondition;
} {
  const maxMatch = text.match(/max\s+(\d+)/i);
  const whileMatch = text.match(/while\s+(.+?)(?:\s+max\s+\d+)?$/i);
  return {
    loopMax: maxMatch ? Number(maxMatch[1]) : undefined,
    loopWhile: whileMatch ? parseConditionText(whileMatch[1]) : undefined,
  };
}

function parseEdgeLabel(label: string): {
  label?: string;
  condition?: FlowCondition;
  loopMax?: number;
} {
  const trimmed = label.trim();
  const lower = trimmed.toLowerCase();

  if (lower === "yes" || lower === "no" || lower === "done" || lower === "default") {
    return { label: lower };
  }

  if (lower.startsWith("loop")) {
    const meta = parseLoopMeta(trimmed);
    return { label: "loop", loopMax: meta.loopMax };
  }

  if (lower.startsWith("if:")) {
    return { label: trimmed, condition: parseConditionText(trimmed) };
  }

  const asCondition = parseConditionText(trimmed);
  if (asCondition) {
    return { label: trimmed, condition: asCondition };
  }

  return { label: trimmed };
}

function parseNodeLabel(
  label: string,
  requestFiles: RunnableRequestFile[],
): { filePath: string; label?: string; runWhen?: FlowCondition } {
  const parts = label.split("|if:");
  const filePart = unescapeMermaidLabel(parts[0].trim());
  const runWhen = parts[1] ? parseConditionText(parts[1]) : undefined;

  const filePath = resolveRequestPath(filePart, requestFiles);
  const match = requestFiles.find((f) => f.path === filePath);

  return {
    filePath,
    label: match?.name ?? filePart.split("/").pop(),
    runWhen,
  };
}

export function resolveRequestPath(
  ref: string,
  requestFiles: RunnableRequestFile[],
): string {
  const exact = requestFiles.find((f) => f.path === ref);
  if (exact) return exact.path;

  const byName = requestFiles.filter(
    (f) => f.name === ref || f.path.endsWith(`/${ref}`),
  );
  if (byName.length === 1) return byName[0].path;

  return ref;
}

function findStartId(
  nodeIds: string[],
  edges: FlowGraphEdge[],
): string {
  const incoming = new Map<string, number>();
  for (const id of nodeIds) incoming.set(id, 0);
  for (const e of edges) {
    incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  }
  return nodeIds.find((id) => (incoming.get(id) ?? 0) === 0) ?? nodeIds[0];
}

function orderRequestNodes(
  graph: FlowGraph,
): string[] {
  const requestIds = graph.nodes
    .filter((n) => n.type === "request")
    .map((n) => n.id);

  if (requestIds.length === 0) return [];

  const outgoing = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!outgoing.has(e.from)) outgoing.set(e.from, []);
    outgoing.get(e.from)!.push(e.to);
  }

  const ordered: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = graph.startId;

  while (current && !seen.has(current)) {
    seen.add(current);
    if (requestIds.includes(current)) ordered.push(current);
    const next: string | undefined = outgoing.get(current)?.[0];
    current = next;
  }

  for (const id of requestIds) {
    if (!ordered.includes(id)) ordered.push(id);
  }

  return ordered;
}

export function parseMermaidFlow(
  source: string,
  requestFiles: RunnableRequestFile[] = [],
): MermaidParseResult {
  const errors: string[] = [];
  const rawNodes = new Map<string, { type: FlowNodeType; text: string }>();

  for (const line of source.split("\n")) {
    const requestMatch = line.match(/^\s*(\w+)\[["'](.+?)["']\]/);
    if (requestMatch) {
      rawNodes.set(requestMatch[1], { type: "request", text: requestMatch[2] });
      continue;
    }

    const conditionMatch = line.match(/^\s*(\w+)\{(.+?)\}/);
    if (conditionMatch) {
      rawNodes.set(conditionMatch[1], {
        type: "condition",
        text: unescapeMermaidLabel(conditionMatch[2].replace(/^["']|["']$/g, "")),
      });
      continue;
    }

    const loopMatch = line.match(/^\s*(\w+)\[\[(.+?)\]\]/);
    if (loopMatch) {
      rawNodes.set(loopMatch[1], {
        type: "loop",
        text: unescapeMermaidLabel(loopMatch[2].replace(/^["']|["']$/g, "")),
      });
    }
  }

  if (rawNodes.size === 0) {
    return {
      steps: [],
      graph: { nodes: [], edges: [], startId: "" },
      errors: ['No nodes found. Use s0["file.bru"], c0{condition}, or loop0[[loop max 3]].'],
    };
  }

  const edges: FlowGraphEdge[] = [];
  for (const line of source.split("\n")) {
    const edgeRegex =
      /(\w+)\s*-->\s*(?:\|\s*([^|]+?)\s*\|\s*)?(\w+)/g;
    let match: RegExpExecArray | null;
    while ((match = edgeRegex.exec(line)) !== null) {
      const parsed = match[2] ? parseEdgeLabel(match[2]) : {};
      edges.push({
        from: match[1],
        to: match[3],
        label: parsed.label,
        condition: parsed.condition,
        loopMax: parsed.loopMax,
      });
    }
  }

  const nodes: FlowGraphNode[] = [];

  for (const [id, raw] of rawNodes.entries()) {
    if (raw.type === "request") {
      const parsed = parseNodeLabel(raw.text, requestFiles);
      if (!parsed.filePath) {
        errors.push(`Node ${id}: missing request path.`);
      }
      if (
        parsed.runWhen &&
        parsed.runWhen.fromStep >= nodes.filter((n) => n.type === "request").length
      ) {
        errors.push(
          `Node ${id}: condition references step${parsed.runWhen.fromStep} before enough prior steps.`,
        );
      }
      nodes.push({
        id,
        type: "request",
        filePath: parsed.filePath,
        label: parsed.label,
        runWhen: parsed.runWhen,
      });
      continue;
    }

    if (raw.type === "condition") {
      const condition = parseConditionText(raw.text);
      if (!condition) {
        errors.push(`Node ${id}: invalid condition "${raw.text}".`);
      }
      nodes.push({ id, type: "condition", condition });
      continue;
    }

    const loopMeta = parseLoopMeta(raw.text);
    if (!loopMeta.loopMax && !raw.text.toLowerCase().includes("loop")) {
      errors.push(`Node ${id}: loop node needs "loop max N" text.`);
    }
    nodes.push({
      id,
      type: "loop",
      label: raw.text,
      loopMax: loopMeta.loopMax ?? 3,
      loopWhile: loopMeta.loopWhile,
    });
  }

  const startId = findStartId(Array.from(rawNodes.keys()), edges);
  const graph: FlowGraph = { nodes, edges, startId };

  const orderedRequestIds = orderRequestNodes(graph);
  const steps: FlowStep[] = orderedRequestIds
    .map((id) => nodes.find((n) => n.id === id))
    .filter((n): n is FlowGraphNode => Boolean(n))
    .map((n) => ({
      id: createFlowStepId(),
      filePath: n.filePath ?? "",
      label: n.label,
      runWhen: n.runWhen,
    }));

  return { steps, graph, errors };
}

export function flowToMermaid(flow: Flow): string {
  if (flow.mermaid?.trim()) return flow.mermaid;

  if (flow.steps.length === 0) return DEFAULT_MERMAID;

  const lines = ["flowchart TD"];
  const ids: string[] = [];

  flow.steps.forEach((step, index) => {
    const id = `s${index}`;
    ids.push(id);
    let label = step.filePath;
    if (step.runWhen) {
      const c = step.runWhen;
      const field =
        c.field === "json"
          ? `json.${c.jsonPath ?? ""}`
          : c.field;
      label += `|if: step${c.fromStep}.${field} ${operatorLabel(c.operator)} ${c.value}`;
    }
    lines.push(`    ${id}["${escapeMermaidLabel(label)}"]`);
  });

  lines.push(`    ${ids.join(" --> ")}`);
  return lines.join("\n");
}

export function syncFlowFromMermaid(
  flow: Flow,
  requestFiles: RunnableRequestFile[],
): string[] {
  const source = flow.mermaid?.trim() ? flow.mermaid : flowToMermaid(flow);
  flow.mermaid = source;

  const { steps, graph, errors } = parseMermaidFlow(source, requestFiles);
  flow.graph = graph;
  if (steps.length > 0) {
    flow.steps = steps;
  }
  return errors;
}

export function ensureFlowMermaid(flow: Flow): void {
  if (!flow.mermaid?.trim()) {
    flow.mermaid = flow.steps.length > 0 ? flowToMermaid(flow) : DEFAULT_MERMAID;
  }
}

export function conditionToMermaidText(condition: FlowCondition): string {
  const field =
    condition.field === "json"
      ? `json.${condition.jsonPath ?? ""}`
      : condition.field;
  return `step${condition.fromStep}.${field} ${condition.operator} ${condition.value}`;
}

export function describeMermaidSyntax(): string {
  return buildSampleMermaid();
}

/** Example with branch (condition) and loop — uses vault files when available. */
export function buildSampleMermaid(
  requestFiles: RunnableRequestFile[] = [],
): string {
  return buildSampleMermaidSource(assignSampleFiles(requestFiles));
}

function isDarkTheme(): boolean {
  return document.body.classList.contains("theme-dark");
}

export async function renderMermaidDiagram(
  parent: HTMLElement,
  source: string,
): Promise<void> {
  if (!mermaidReady) {
    mermaid.initialize({
      startOnLoad: false,
      theme: isDarkTheme() ? "dark" : "default",
      securityLevel: "loose",
      flowchart: { htmlLabels: true, curve: "basis" },
    });
    mermaidReady = true;
  }

  parent.empty();
  const wrap = parent.createDiv({ cls: "brunet-flow-mermaid-svg" });

  const id = `brunet-mmd-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const { svg } = await mermaid.render(id, source);
    wrap.innerHTML = svg;
  } catch (err) {
    wrap.createEl("p", {
      cls: "brunet-flow-mermaid-error",
      text: err instanceof Error ? err.message : String(err),
    });
  }
}

export function highlightRunState(
  diagramHost: HTMLElement,
  outcomes: Array<{ index: number; skipped: boolean; status?: number }>,
): void {
  const nodes = diagramHost.querySelectorAll(".node");
  nodes.forEach((node, index) => {
    const el = node as HTMLElement;
    el.classList.remove(
      "brunet-mmd-ok",
      "brunet-mmd-err",
      "brunet-mmd-skipped",
    );
    const outcome = outcomes[index];
    if (!outcome) return;
    if (outcome.skipped) {
      el.classList.add("brunet-mmd-skipped");
    } else if (outcome.status && outcome.status >= 200 && outcome.status < 300) {
      el.classList.add("brunet-mmd-ok");
    } else if (outcome.status !== undefined) {
      el.classList.add("brunet-mmd-err");
    }
  });
}

export { DEFAULT_MERMAID, describeFlowCondition };
