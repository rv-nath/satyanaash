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
