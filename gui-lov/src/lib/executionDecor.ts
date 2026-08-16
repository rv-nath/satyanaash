/**
 * What a run leaves on the canvas.
 *
 * The canvas has one mechanism for saying something about a node: a class on React
 * Flow's own wrapper, picked up by CSS on the node's outer div. Validation already
 * uses it. Execution state is the same idea, so the decision of which class a node
 * gets lives here as a plain function — the arithmetic of "which node is where in the
 * run" is worth testing without mounting a graph.
 */
import type { InlinedGroup, TestCaseExecutionResult } from "@/lib/api/types";
import { oneLine } from "@/lib/dataset";

/** Where one node stands in the run on screen. */
export type NodeExecState = "running" | "next" | "passed" | "failed" | "error" | "skipped";

export interface ExecutionView {
  /** The node whose request is in flight. */
  activeNodeId: string | null;
  /** The node a paused run is waiting to run. */
  pausedNodeId: string | null;
  /** This flow's results so far, by node id. */
  runs: Record<string, TestCaseExecutionResult> | undefined;
  /**
   * What each sub-flow node on the canvas turned into, off the run's `started` event.
   *
   * Without it a sub-flow node is decorated by nothing at all: the run reports under the
   * inner ids, which match no node on the canvas, so the one box the author *can* see stays
   * blank while four of its steps pass and one fails. The running ring and the paused "next"
   * marker vanish with it.
   */
  inlined?: InlinedGroup[];
}

/**
 * The run, as one flow's canvas sees it.
 *
 * Built here rather than at each reader, because the guards are not obvious and getting one
 * wrong is silent: `activeNodeId` and `pausedNodeId` belong to whichever flow is running and
 * must not decorate another one's graph, while `runs` and `inlined` are per flow already and
 * **must not** be gated on the run being live — a verdict that vanished when the run ended
 * would leave the canvas blank about a run the author is still reading.
 */
export function flowExecutionView(ctx: {
  activeFlowId: string | null;
  executingFlowId: string | null;
  activeNodeId: string | null;
  pausedNodeId: string | null;
  nodeRuns: Record<string, Record<string, TestCaseExecutionResult>>;
  inlinedByFlow: Record<string, InlinedGroup[]>;
}): ExecutionView {
  const mine = ctx.executingFlowId === ctx.activeFlowId;
  return {
    activeNodeId: mine ? ctx.activeNodeId : null,
    pausedNodeId: mine ? ctx.pausedNodeId : null,
    runs: ctx.activeFlowId ? ctx.nodeRuns[ctx.activeFlowId] : undefined,
    inlined: ctx.activeFlowId ? ctx.inlinedByFlow[ctx.activeFlowId] : undefined,
  };
}

/**
 * What to say about one node, or undefined for nothing to say.
 *
 * In flight wins over a stored result, because a node re-run in a later pass is more
 * interesting than what it did in an earlier one. "Next" only applies while paused:
 * once the run is moving, the node about to run is a detail nobody can act on.
 *
 * A sub-flow node has no result of its own — it isn't in the run at all — so it takes the
 * worst of the steps it stands for, and their running/next state as its own.
 */
export function nodeExecState(nodeId: string, view: ExecutionView): NodeExecState | undefined {
  if (view.activeNodeId === nodeId) return "running";
  if (view.pausedNodeId === nodeId) return "next";
  const status = view.runs?.[nodeId]?.status ?? subFlowStatus(nodeId, view);
  switch (status) {
    case "running":
      return "running";
    case "next":
      return "next";
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "error":
      return "error";
    case "skipped":
      return "skipped";
    default:
      return undefined;
  }
}

/** Which entry, if any, says this canvas node is a sub-flow. */
function groupOf(nodeId: string, view: ExecutionView): InlinedGroup | undefined {
  return view.inlined?.find((g) => g.group_node_id === nodeId);
}

/**
 * Worst-of over the steps a sub-flow node stands for, with a live step outranking any of it.
 *
 * The ladder is the engine's own — an error outranks a failure, because a step that could not
 * run is systemic. `skipped` sits at the bottom: the tail of steps skipped after something
 * upstream failed shouldn't repaint a sub-flow whose own steps passed, and the failure that
 * caused them is already showing on whichever node it belongs to.
 */
function subFlowStatus(nodeId: string, view: ExecutionView): NodeExecState | undefined {
  const group = groupOf(nodeId, view);
  if (!group) return undefined;
  const inner = group.node_ids;
  // A step of this sub-flow is the one in flight, or the one a paused run is parked before.
  // Said here because the events name an inner id, which matches nothing on the canvas.
  if (view.activeNodeId && inner.includes(view.activeNodeId)) return "running";
  if (view.pausedNodeId && inner.includes(view.pausedNodeId)) return "next";

  const rank: Record<string, number> = { error: 4, failed: 3, passed: 2, skipped: 1 };
  let worst: NodeExecState | undefined;
  for (const id of inner) {
    const status = view.runs?.[id]?.status;
    if (!status || !(status in rank)) continue;
    if (!worst || rank[status] > rank[worst]) worst = status as NodeExecState;
  }
  return worst;
}

/** What a sub-flow node can say about itself while and after it runs. */
export interface GroupRollup {
  flowName: string;
  /** Steps this sub-flow contributed to the run. */
  total: number;
  /** How many have a verdict yet. */
  done: number;
  failed: number;
  errors: number;
  /** The step of this sub-flow in flight, if one is. */
  runningNodeId: string | null;
}

/**
 * The counts a sub-flow node shows — "3 of 4 · 1 failed".
 *
 * A sub-flow node is one box standing for several steps, so unlike every other node its
 * verdict alone loses information: "failed" over four steps does not say whether one of them
 * failed or all four did. Undefined when this node is not a sub-flow node in this run.
 */
export function groupRollup(nodeId: string, view: ExecutionView): GroupRollup | undefined {
  const group = groupOf(nodeId, view);
  if (!group) return undefined;
  const results = group.node_ids.map((id) => view.runs?.[id]).filter(Boolean);
  return {
    flowName: group.flow_name,
    total: group.node_ids.length,
    done: results.length,
    failed: results.filter((r) => r!.status === "failed").length,
    errors: results.filter((r) => r!.status === "error").length,
    runningNodeId:
      view.activeNodeId && group.node_ids.includes(view.activeNodeId) ? view.activeNodeId : null,
  };
}

/**
 * The sub-flow a reported node belongs to, or undefined for one of the flow's own steps.
 *
 * A lookup, never a parse. The ids are joined by an unprintable separator so that splitting
 * one is impossible to do by accident — a sub-flow's name is not recoverable from its id, and
 * must not appear to be.
 */
export function subFlowNameFor(
  nodeId: string,
  inlined: InlinedGroup[] | undefined,
): string | undefined {
  return inlined?.find((g) => g.node_ids.includes(nodeId))?.flow_name;
}

/** The class name carrying that state to the CSS in index.css. */
export function executionClassFor(nodeId: string, view: ExecutionView): string {
  const state = nodeExecState(nodeId, view);
  return state ? `exec-${state}` : "";
}

/**
 * What to call a canvas node.
 *
 * The author's alias wins, exactly as it does in the log (`nodeName`) — a paused run
 * has not produced a result yet, so the name has to come off the graph.
 */
export function canvasNodeName(
  nodes: { id: string; data?: Record<string, unknown> }[],
  nodeId: string,
): string {
  const data = nodes.find((n) => n.id === nodeId)?.data ?? {};
  const text = (key: string) => (typeof data[key] === "string" ? (data[key] as string).trim() : "");
  return text("alias") || text("label") || nodeId;
}

/** How many nodes of this flow have finished — the "4 of 7" in the step controls. */
export function completedCount(runs: Record<string, TestCaseExecutionResult> | undefined): number {
  return runs ? Object.keys(runs).length : 0;
}

/**
 * What a node exported, one line each, for the node's popover.
 *
 * Cut short and told how long it was: a JWT is 2.5KB, and dumped in full it would push
 * everything else off the screen. The console still carries the whole value.
 */
export function exportLines(
  exports: Record<string, unknown> | null | undefined,
  limit = 44,
): { name: string; value: string }[] {
  if (!exports) return [];
  return Object.entries(exports).map(([name, raw]) => {
    const text = typeof raw === "string" ? raw : JSON.stringify(raw) ?? String(raw);
    const flat = oneLine(text);
    return {
      name,
      value: flat.length > limit ? `${flat.slice(0, limit)}… (${flat.length} chars)` : flat,
    };
  });
}

/**
 * Which record each row of a fan-out contributed.
 *
 * Shown beside the row rather than in one block above the table, because "which row produced
 * this id" is the question, and a list of records that answers it only by a `_row` field the
 * reader has to cross-reference is answering it the long way round.
 *
 * **Zipped, not looked up by label.** Both sequences are in row order and only passing rows
 * with a match contribute, so walking them together is exact — where matching on `_row` alone
 * would pair the wrong record with the wrong row the moment two rows share a name, which
 * nothing prevents.
 */
export function collectedByRow(aggregate: {
  iterations?: { row_label?: string }[];
  exports?: Record<string, unknown> | null;
}): {
  /** Keyed by position in `iterations`. */
  byRow: Map<number, Record<string, unknown>>;
  /** Records no row claimed. Should be empty; shown separately if it ever isn't, because
   *  silently dropping a collected value is worse than an odd-looking extra block. */
  unclaimed: Record<string, unknown>[];
} {
  const rows = aggregate.iterations ?? [];
  const records = Object.values(aggregate.exports ?? {})
    .filter((v): v is unknown[] => Array.isArray(v))
    .flat()
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object");

  const byRow = new Map<number, Record<string, unknown>>();
  let next = 0;
  rows.forEach((row, i) => {
    const record = records[next];
    if (record && record[RECORD_ROW_KEY] === (row.row_label ?? "")) {
      byRow.set(i, record);
      next += 1;
    }
  });
  return { byRow, unclaimed: records.slice(next) };
}

/** The engine's reserved field naming the row a record came from. */
export const RECORD_ROW_KEY = "_row";

/** A record's own fields, without the bookkeeping one. */
export function recordFields(record: Record<string, unknown>): { name: string; value: string }[] {
  const { [RECORD_ROW_KEY]: _row, ...fields } = record;
  return exportLines(fields, 60);
}
