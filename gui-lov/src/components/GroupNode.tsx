import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { FolderTree, Loader2 } from "lucide-react";
import { useTestProject } from "@/contexts/TestProjectContext";
import { statusIcon } from "@/lib/consoleDetails";
import { flowExecutionView, groupRollup, nodeExecState } from "@/lib/executionDecor";

/**
 * A step that runs another flow.
 *
 * Its steps are spliced into this flow before the run, so what executes is one flat flow and
 * this node is not in it — the run reports under ids that name no node on the canvas. Which is
 * why everything here is a **roll-up**: the verdict is the worst of the steps it stands for,
 * and the counts beside it are the part a single verdict loses ("failed" over four steps does
 * not say whether one failed or all four).
 *
 * The roll-up is a lookup through the map the run announces, never a parse of an id. Nothing
 * may recover a sub-flow from the shape of a node id.
 *
 * Double-click opens the flow it runs, as a tab like any other. It used to open a modal editor
 * whose edits were never saved — one flow, one editor, and edits that persist.
 */
interface GroupNodeData {
  /** A snapshot of the flow's name from when the node was dropped. Only a fallback: the live
   *  name is resolved below, so a renamed flow does not leave stale nodes behind. */
  label?: string;
  /** The flow this node runs. */
  flowId: string;
}

interface GroupNodeProps {
  /** React Flow passes the node's own id — the key the roll-up is looked up under. */
  id: string;
  data: GroupNodeData;
}

const statusTone = (state: string) =>
  state === "passed"
    ? "bg-success text-success-foreground"
    : state === "failed" || state === "error"
      ? "bg-destructive text-destructive-foreground"
      : "bg-muted-foreground text-background";

export const GroupNode = memo(({ id, data }: GroupNodeProps) => {
  const { flows, activeFlowId, executingFlowId, nodeRuns, inlinedByFlow, activeNodeId, pausedNodeId, openFlowOnCanvas } =
    useTestProject();

  // The flow this node runs, resolved live. A stale `label` used to survive a rename, and now
  // matters more than it did: a node pointing at a deleted flow stops the run before it starts.
  const target = flows.find((f) => f.id === data.flowId);
  const name = target?.name ?? data.label?.trim() ?? "";

  // The same view the canvas decorates from — built in one place, because which parts are
  // gated on the run being live is not obvious and getting it wrong is silent.
  const view = flowExecutionView({
    activeFlowId,
    executingFlowId,
    activeNodeId,
    pausedNodeId,
    nodeRuns,
    inlinedByFlow,
  });
  const state = nodeExecState(id, view);
  const rollup = groupRollup(id, view);
  const running = state === "running";

  // What the sub-flow will contribute, before it has ever run. Counted off the flow itself
  // rather than carried on the node, where it was hard-coded to 0 and always read "0 test cases".
  const steps = target?.internalNodes?.filter(
    (n) => n.type === "testCase" || n.type === "awaitCallback" || n.type === "group",
  ).length;

  return (
    <div
      className="relative w-[260px] rounded-lg border-2 border-node-group bg-card px-4 py-3 shadow-lg transition-shadow hover:shadow-xl"
      onDoubleClick={(e) => {
        e.stopPropagation();
        // Both halves: `openFlowTab` alone adds a tab the canvas never switches to, which is
        // exactly how this looked like a dead gesture. Opening the sub-flow is how you edit it.
        if (data.flowId) openFlowOnCanvas(data.flowId);
      }}
      title={target ? `Runs ${name} — double-click to open it` : undefined}
    >
      {/* Ids match the other node types so edges can be re-routed to the
          left/right ports when the graph is arranged horizontally. */}
      <Handle id="target-top" type="target" position={Position.Top} className="w-3 h-3 !bg-node-group" />
      <Handle id="target-left" type="target" position={Position.Left} className="w-3 h-3 !bg-node-group" />

      {/* The verdict, on the corner and outside the row — the same place, size and ring every
          other node type puts it. In the row it would widen the node, and nothing about a run
          may change a node's size. */}
      {state && (
        <span
          className={`absolute -right-2 -top-2 flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-card text-[10px] font-bold leading-none shadow-sm ${
            running || state === "next" ? "bg-primary text-primary-foreground" : statusTone(state)
          }`}
          title={
            running
              ? `Running a step of ${name}`
              : state === "next"
                ? `Next: a step of ${name}`
                : `Worst of this sub-flow's steps: ${state}`
          }
          aria-label={running ? "running" : state}
        >
          {running ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin motion-reduce:animate-none" />
          ) : state === "next" ? (
            "▸"
          ) : (
            statusIcon(state)
          )}
        </span>
      )}

      <div className="flex items-start gap-2">
        <FolderTree className="mt-0.5 h-4 w-4 flex-shrink-0 text-node-group" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          {/* Truncated, which needs the fixed width above to mean anything: left free, a long
              flow name grew the node to 440px and left it out of scale with everything around
              it. Fixed rather than clamped because of the line below — "nothing about a run may
              change a node's size", and `3 of 4 steps · 1 failed · 1 errored` is wider than
              `4 steps`. A node that grows re-centres itself, which quietly undoes an alignment
              the author made before the run. */}
          <div className="truncate text-sm font-semibold text-foreground">
            {name || "Sub-flow"}
          </div>
          {/* Before a run: what it will contribute. During and after: how far it got. One box
              standing for several steps is the whole point of this node, and also the whole
              reason its single verdict is not enough on its own. */}
          {!target ? (
            <div className="mt-1 text-xs text-destructive">
              flow not found — this run will not start
            </div>
          ) : rollup && rollup.done > 0 ? (
            <div className="mt-1 truncate text-xs text-muted-foreground">
              {rollup.done} of {rollup.total} steps
              {rollup.failed > 0 && (
                <span className="text-destructive"> · {rollup.failed} failed</span>
              )}
              {rollup.errors > 0 && (
                <span className="text-destructive"> · {rollup.errors} errored</span>
              )}
            </div>
          ) : (
            <div className="mt-1 text-xs text-muted-foreground">
              {steps === undefined ? "runs another flow" : `${steps} step${steps === 1 ? "" : "s"}`}
            </div>
          )}
        </div>
      </div>

      <Handle id="source-bottom" type="source" position={Position.Bottom} className="w-3 h-3 !bg-node-group" />
      <Handle id="source-right" type="source" position={Position.Right} className="w-3 h-3 !bg-node-group" />
    </div>
  );
});

GroupNode.displayName = "GroupNode";
