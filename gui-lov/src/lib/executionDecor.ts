/**
 * What a run leaves on the canvas.
 *
 * The canvas has one mechanism for saying something about a node: a class on React
 * Flow's own wrapper, picked up by CSS on the node's outer div. Validation already
 * uses it. Execution state is the same idea, so the decision of which class a node
 * gets lives here as a plain function — the arithmetic of "which node is where in the
 * run" is worth testing without mounting a graph.
 */
import type { TestCaseExecutionResult } from "@/lib/api/types";
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
}

/**
 * What to say about one node, or undefined for nothing to say.
 *
 * In flight wins over a stored result, because a node re-run in a later pass is more
 * interesting than what it did in an earlier one. "Next" only applies while paused:
 * once the run is moving, the node about to run is a detail nobody can act on.
 */
export function nodeExecState(nodeId: string, view: ExecutionView): NodeExecState | undefined {
  if (view.activeNodeId === nodeId) return "running";
  if (view.pausedNodeId === nodeId) return "next";
  const status = view.runs?.[nodeId]?.status;
  switch (status) {
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
