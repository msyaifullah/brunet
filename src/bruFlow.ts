/**
 * Flow runner — sequential .bru / .yml requests with optional conditions.
 */

import { TFile, Vault } from "obsidian";
import { parseBruFile } from "./bruParser";
import { parseBruYml, isRunnableBrunoYml } from "./bruYmlParser";
import {
  isEnvironmentFile,
  isRunnableBruFile,
  loadCollectionVars,
} from "./bruCollection";
import { runBruRequest, type BruRunResult } from "./bruRunner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FlowConditionField = "status" | "body" | "json";
export type FlowConditionOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "not_contains";

export interface FlowCondition {
  /** 0-based index of the executed request to inspect (step0, step1, …). */
  fromStep: number;
  /** Graph node id to inspect (s0, s_ok, …) — preferred over fromStep when set. */
  fromNodeId?: string;
  field: FlowConditionField;
  /** Dot path when field is "json", e.g. "data.token". */
  jsonPath?: string;
  operator: FlowConditionOperator;
  value: string;
}

export type FlowNodeType = "request" | "condition" | "loop";

export interface FlowGraphNode {
  id: string;
  type: FlowNodeType;
  filePath?: string;
  label?: string;
  /** Request node: run only when true. */
  runWhen?: FlowCondition;
  /** Condition diamond: branch on this. */
  condition?: FlowCondition;
  /** Loop marker node: max iterations. */
  loopMax?: number;
  loopWhile?: FlowCondition;
}

export interface FlowGraphEdge {
  from: string;
  to: string;
  /** yes | no | done | loop | loop max N | if: ... */
  label?: string;
  condition?: FlowCondition;
  loopMax?: number;
}

export interface FlowGraph {
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
  startId: string;
}

export interface FlowStep {
  id: string;
  filePath: string;
  label?: string;
  /** When set, the step runs only if this condition is true. */
  runWhen?: FlowCondition;
}

export interface Flow {
  id: string;
  name: string;
  stopOnError: boolean;
  /** Mermaid flowchart source (primary editor format). */
  mermaid: string;
  steps: FlowStep[];
  /** Parsed graph (derived from mermaid on sync). */
  graph?: FlowGraph;
}

export interface FlowStepOutcome {
  step: FlowStep;
  index: number;
  skipped: boolean;
  skipReason?: string;
  result: BruRunResult | null;
}

export interface FlowRunResult {
  flowId: string;
  stopped: boolean;
  stopReason?: string;
  outcomes: FlowStepOutcome[];
}

export interface RunnableRequestFile {
  path: string;
  name: string;
  method: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function createFlowId(): string {
  return `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createFlowStepId(): string {
  return `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createDefaultFlow(name = "New flow"): Flow {
  return {
    id: createFlowId(),
    name,
    stopOnError: true,
    mermaid: "",
    steps: [],
  };
}

function getJsonPath(obj: unknown, path: string): unknown {
  if (!path.trim()) return obj;
  let current = obj;
  for (const part of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function compareValues(
  actual: string,
  expected: string,
  operator: FlowConditionOperator,
): boolean {
  const numActual = Number(actual);
  const numExpected = Number(expected);
  const numeric =
    !Number.isNaN(numActual) &&
    !Number.isNaN(numExpected) &&
    actual.trim() !== "" &&
    expected.trim() !== "";

  switch (operator) {
    case "eq":
      return numeric ? numActual === numExpected : actual === expected;
    case "neq":
      return numeric ? numActual !== numExpected : actual !== expected;
    case "gt":
      return numeric ? numActual > numExpected : actual > expected;
    case "gte":
      return numeric ? numActual >= numExpected : actual >= expected;
    case "lt":
      return numeric ? numActual < numExpected : actual < expected;
    case "lte":
      return numeric ? numActual <= numExpected : actual <= expected;
    case "contains":
      return actual.includes(expected);
    case "not_contains":
      return !actual.includes(expected);
    default:
      return false;
  }
}

function extractConditionValue(
  outcome: FlowStepOutcome,
  condition: FlowCondition,
): string {
  const result = outcome.result;
  if (!result) return "";

  if (condition.field === "status") {
    return String(result.response.status);
  }

  if (condition.field === "body") {
    return result.response.body;
  }

  const json = result.response.json;
  if (json == null) return "";
  const atPath = getJsonPath(json, condition.jsonPath ?? "");
  if (atPath == null) return "";
  if (typeof atPath === "object") return JSON.stringify(atPath);
  return String(atPath);
}

function outcomeForStepIndex(
  outcomes: FlowStepOutcome[],
  stepIndex: number,
): FlowStepOutcome | undefined {
  const executed = outcomes.filter((o) => o.result !== null);
  if (stepIndex < executed.length) return executed[stepIndex];
  return outcomes[stepIndex];
}

export function evaluateFlowCondition(
  condition: FlowCondition,
  outcomes: FlowStepOutcome[],
  outcomeByNodeId?: Map<string, FlowStepOutcome>,
): boolean {
  let source: FlowStepOutcome | undefined;
  if (condition.fromNodeId && outcomeByNodeId) {
    source = outcomeByNodeId.get(condition.fromNodeId);
  }
  if (!source) {
    source = outcomeForStepIndex(outcomes, condition.fromStep);
  }
  if (!source || source.skipped || !source.result) return false;

  const actual = extractConditionValue(source, condition);
  return compareValues(actual, condition.value, condition.operator);
}

export function describeFlowCondition(condition: FlowCondition): string {
  const ref = condition.fromNodeId ?? `step${condition.fromStep}`;
  const field =
    condition.field === "json"
      ? `json.${condition.jsonPath || "?"}`
      : condition.field;
  return `${ref} ${field} ${condition.operator} ${condition.value}`;
}

function isRunnableRequestFile(vault: Vault, file: TFile): boolean {
  if (file.extension === "bru") {
    return (
      !isEnvironmentFile(file) &&
      file.basename !== "collection" &&
      file.basename !== "folder"
    );
  }
  if (file.extension === "yml" || file.extension === "yaml") {
    return (
      !isEnvironmentFile(file) &&
      file.basename !== "folder" &&
      file.basename !== "collection" &&
      file.basename !== "opencollection"
    );
  }
  return false;
}

export async function listRunnableRequestFiles(
  vault: Vault,
): Promise<RunnableRequestFile[]> {
  const candidates = vault
    .getFiles()
    .filter((f) => isRunnableRequestFile(vault, f));

  const results: RunnableRequestFile[] = [];

  for (const file of candidates) {
    try {
      const content = await vault.cachedRead(file);
      const isYml = file.extension === "yml" || file.extension === "yaml";

      if (isYml) {
        if (!isRunnableBrunoYml(content, file)) continue;
        const parsed = parseBruYml(content);
        results.push({
          path: file.path,
          name: file.basename,
          method: parsed.request.method || "?",
        });
      } else {
        const parsed = parseBruFile(content);
        if (!isRunnableBruFile(parsed, file)) continue;
        results.push({
          path: file.path,
          name: file.basename,
          method: parsed.request.method || "?",
        });
      }
    } catch {
      /* skip unreadable files */
    }
  }

  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

async function runFlowStep(
  vault: Vault,
  step: FlowStep,
  environmentName: string,
): Promise<BruRunResult> {
  const file = vault.getAbstractFileByPath(step.filePath);
  if (!(file instanceof TFile)) {
    throw new Error(`Request file not found: ${step.filePath}`);
  }

  const content = await vault.cachedRead(file);
  const isYml = file.extension === "yml" || file.extension === "yaml";
  const parsed = isYml ? parseBruYml(content) : parseBruFile(content);
  const collectionVars = await loadCollectionVars(
    vault,
    file,
    environmentName,
  );

  return runBruRequest(parsed, { collectionVars });
}

function isStepFailure(result: BruRunResult): boolean {
  if (result.response.error && result.response.status === 0) return true;
  if (result.response.status < 200 || result.response.status >= 300) {
    return true;
  }
  return false;
}

function graphNodeToStep(node: FlowGraphNode): FlowStep {
  return {
    id: node.id,
    filePath: node.filePath ?? node.id,
    label: node.label ?? node.id,
    runWhen: node.runWhen,
  };
}

function countNodeExecutions(
  outcomes: FlowStepOutcome[],
  node: FlowGraphNode,
): number {
  return outcomes.filter(
    (o) =>
      !o.skipped &&
      (o.step.filePath === node.filePath ||
        o.step.label === node.label ||
        o.step.id === node.id),
  ).length;
}

function outgoingEdges(
  graph: FlowGraph,
  nodeId: string,
): FlowGraphEdge[] {
  return graph.edges.filter((e) => e.from === nodeId);
}

function pickBranchEdge(
  edges: FlowGraphEdge[],
  pass: boolean,
): FlowGraphEdge | undefined {
  const want = pass ? "yes" : "no";
  return edges.find((e) => e.label?.toLowerCase() === want);
}

function nextNodeAfterEdge(
  graph: FlowGraph,
  nodeMap: Map<string, FlowGraphNode>,
  edge: FlowGraphEdge | undefined,
): FlowGraphNode | undefined {
  if (!edge) return undefined;
  return nodeMap.get(edge.to);
}

function pickLoopEdge(
  edges: FlowGraphEdge[],
  node: FlowGraphNode,
  outcomes: FlowStepOutcome[],
): FlowGraphEdge | undefined {
  const done = edges.find((e) => e.label?.toLowerCase() === "done");
  const loopEdges = edges.filter((e) =>
    e.label?.toLowerCase().startsWith("loop"),
  );

  for (const edge of loopEdges) {
    const max = edge.loopMax ?? node.loopMax ?? 1;
    const runs = countNodeExecutions(outcomes, node);
    if (runs < max) return edge;
  }

  return done ?? edges.find((e) => e.label?.toLowerCase() !== "loop");
}

function pickNextEdge(
  graph: FlowGraph,
  node: FlowGraphNode,
  outcomes: FlowStepOutcome[],
  outcomeByNodeId?: Map<string, FlowStepOutcome>,
): FlowGraphEdge | undefined {
  const edges = outgoingEdges(graph, node.id);
  if (edges.length === 0) return undefined;
  if (edges.length === 1) return edges[0];

  const hasLoop = edges.some((e) => e.label?.toLowerCase().startsWith("loop"));
  if (hasLoop) return pickLoopEdge(edges, node, outcomes);

  const hasDone = edges.some((e) => e.label?.toLowerCase() === "done");
  if (hasDone) {
    return edges.find((e) => e.label?.toLowerCase() === "done") ?? edges[0];
  }

  return edges.find((e) => {
    if (!e.condition) return false;
    return evaluateFlowCondition(e.condition, outcomes, outcomeByNodeId);
  }) ?? edges[0];
}

export function hasGraphExecution(graph: FlowGraph | undefined): boolean {
  if (!graph || graph.nodes.length === 0) return false;
  if (graph.nodes.some((n) => n.type !== "request")) return true;
  if (graph.edges.some((e) => Boolean(e.label?.trim()))) return true;

  const outCount = new Map<string, number>();
  for (const edge of graph.edges) {
    outCount.set(edge.from, (outCount.get(edge.from) ?? 0) + 1);
  }
  if ([...outCount.values()].some((count) => count > 1)) return true;

  return graph.edges.length > 0;
}

export async function runFlowGraph(
  graph: FlowGraph,
  flow: Flow,
  vault: Vault,
  environmentName: string,
  onStep?: (outcome: FlowStepOutcome) => void,
): Promise<FlowRunResult> {
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const outcomes: FlowStepOutcome[] = [];
  const outcomeByNodeId = new Map<string, FlowStepOutcome>();
  let current: string | undefined = graph.startId;
  let guard = 0;
  const maxSteps = 50;

  while (current && guard < maxSteps) {
    guard++;
    const node = nodeMap.get(current);
    if (!node) break;

    if (node.type === "condition") {
      if (!node.condition) {
        return {
          flowId: flow.id,
          stopped: true,
          stopReason: `Condition node ${node.id} has no expression`,
          outcomes,
        };
      }
      const pass = evaluateFlowCondition(
        node.condition,
        outcomes,
        outcomeByNodeId,
      );
      const branchEdges = outgoingEdges(graph, node.id);
      const edge = pickBranchEdge(branchEdges, pass);
      if (!edge) {
        const branch = pass ? "yes" : "no";
        return {
          flowId: flow.id,
          stopped: true,
          stopReason: `No |${branch}| branch from ${node.id} (${describeFlowCondition(node.condition)} was ${pass ? "true" : "false"})`,
          outcomes,
        };
      }
      onStep?.({
        step: {
          id: `branch-${node.id}`,
          filePath: "",
          label: `${node.id} → ${pass ? "yes" : "no"}`,
        },
        index: outcomes.length,
        skipped: true,
        skipReason: `Branch: ${describeFlowCondition(node.condition)} → ${pass ? "yes" : "no"} (${edge.to})`,
        result: null,
      });
      current = edge.to;
      continue;
    }

    if (node.type === "loop") {
      const bodyEdge = outgoingEdges(graph, node.id).find(
        (e) =>
          e.label?.toLowerCase() !== "done" &&
          !e.label?.toLowerCase().startsWith("loop"),
      );
      current = bodyEdge?.to;
      continue;
    }

    const step = graphNodeToStep(node);
    const index = outcomes.length;

    if (node.runWhen && !evaluateFlowCondition(node.runWhen, outcomes, outcomeByNodeId)) {
      const outcome: FlowStepOutcome = {
        step,
        index,
        skipped: true,
        skipReason: `Condition not met: ${describeFlowCondition(node.runWhen)}`,
        result: null,
      };
      outcomes.push(outcome);
      onStep?.(outcome);
      const edge = pickNextEdge(graph, node, outcomes, outcomeByNodeId);
      current = edge?.to;
      continue;
    }

    if (!node.filePath) {
      const edge = pickNextEdge(graph, node, outcomes, outcomeByNodeId);
      current = edge?.to;
      continue;
    }

    let result: BruRunResult;
    try {
      result = await runFlowStep(vault, step, environmentName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const outcome: FlowStepOutcome = {
        step,
        index,
        skipped: false,
        result: {
          request: { method: "?", url: step.filePath, headers: {} },
          response: {
            status: 0,
            statusText: "Error",
            headers: {},
            body: "",
            json: null,
            durationMs: 0,
            error: message,
          },
        },
      };
      outcomes.push(outcome);
      outcomeByNodeId.set(node.id, outcome);
      onStep?.(outcome);

      const edge = pickNextEdge(graph, node, outcomes, outcomeByNodeId);
      const nextNode = nextNodeAfterEdge(graph, nodeMap, edge);

      if (flow.stopOnError && nextNode?.type !== "condition") {
        return {
          flowId: flow.id,
          stopped: true,
          stopReason: message,
          outcomes,
        };
      }

      current = edge?.to;
      continue;
    }

    const outcome: FlowStepOutcome = {
      step,
      index,
      skipped: false,
      result,
    };
    outcomes.push(outcome);
    outcomeByNodeId.set(node.id, outcome);
    onStep?.(outcome);

    const edge = pickNextEdge(graph, node, outcomes, outcomeByNodeId);
    const nextNode = nextNodeAfterEdge(graph, nodeMap, edge);

    if (flow.stopOnError && isStepFailure(result) && nextNode?.type !== "condition") {
      const status = result.response.status;
      return {
        flowId: flow.id,
        stopped: true,
        stopReason: result.response.error ?? `HTTP ${status}`,
        outcomes,
      };
    }

    current = edge?.to;
  }

  if (guard >= maxSteps) {
    return {
      flowId: flow.id,
      stopped: true,
      stopReason: "Flow exceeded maximum steps (possible infinite loop)",
      outcomes,
    };
  }

  return {
    flowId: flow.id,
    stopped: false,
    outcomes,
  };
}

export async function runFlow(
  flow: Flow,
  vault: Vault,
  environmentName: string,
  onStep?: (outcome: FlowStepOutcome) => void,
): Promise<FlowRunResult> {
  if (hasGraphExecution(flow.graph)) {
    return runFlowGraph(
      flow.graph!,
      flow,
      vault,
      environmentName,
      onStep,
    );
  }

  const outcomes: FlowStepOutcome[] = [];

  for (let index = 0; index < flow.steps.length; index++) {
    const step = flow.steps[index];

    if (step.runWhen && !evaluateFlowCondition(step.runWhen, outcomes)) {
      const outcome: FlowStepOutcome = {
        step,
        index,
        skipped: true,
        skipReason: `Condition not met: ${describeFlowCondition(step.runWhen)}`,
        result: null,
      };
      outcomes.push(outcome);
      onStep?.(outcome);
      continue;
    }

    let result: BruRunResult;
    try {
      result = await runFlowStep(vault, step, environmentName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const outcome: FlowStepOutcome = {
        step,
        index,
        skipped: false,
        result: {
          request: { method: "?", url: step.filePath, headers: {} },
          response: {
            status: 0,
            statusText: "Error",
            headers: {},
            body: "",
            json: null,
            durationMs: 0,
            error: message,
          },
        },
      };
      outcomes.push(outcome);
      onStep?.(outcome);

      if (flow.stopOnError) {
        return {
          flowId: flow.id,
          stopped: true,
          stopReason: message,
          outcomes,
        };
      }
      continue;
    }

    const outcome: FlowStepOutcome = {
      step,
      index,
      skipped: false,
      result,
    };
    outcomes.push(outcome);
    onStep?.(outcome);

    if (flow.stopOnError && isStepFailure(result)) {
      const status = result.response.status;
      return {
        flowId: flow.id,
        stopped: true,
        stopReason: result.response.error ?? `HTTP ${status}`,
        outcomes,
      };
    }
  }

  return {
    flowId: flow.id,
    stopped: false,
    outcomes,
  };
}
