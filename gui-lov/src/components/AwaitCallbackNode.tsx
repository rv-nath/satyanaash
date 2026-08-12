import { memo, useEffect, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { Hourglass, Loader2 } from "lucide-react";
import { useTestProject } from "@/contexts/TestProjectContext";
import { awaitBadge, awaitTimeoutMs, type NodeConfig } from "@/lib/nodeConfig";

/**
 * A step that waits for an inbound callback instead of sending a request.
 *
 * A control node, like start and end — no test case behind it, no method, no URL. But unlike
 * those two it reports a verdict, so it is drawn as a step with both handles and it wears its
 * last run the way a test-case node does: "the delivery report never came" is a test result,
 * and the whole point of the node is that it can be red.
 *
 * Amber rather than the primary the request nodes use, and the same amber the poll badge picked,
 * because both are about time passing rather than about a call being made.
 *
 * **While it waits it spins, and counts.** The shared `exec-running` ring is all a request node
 * needs, because a request node is done in milliseconds — nobody is watching it long enough to
 * wonder. This step can sit for a minute, and over a minute a static ring answers neither "is
 * this alive?" nor "how much longer?". The elapsed count answers both, and it is the part that
 * survives `prefers-reduced-motion`: the spinner stops, the number does not.
 */
interface AwaitCallbackNodeData {
  label?: string;
  alias?: string;
  config?: NodeConfig;
}

interface AwaitCallbackNodeProps {
  id: string;
  data: AwaitCallbackNodeData;
}

export const AwaitCallbackNode = memo(({ id, data }: AwaitCallbackNodeProps) => {
  const { activeFlowId, executingFlowId, nodeRuns, activeNodeId } = useTestProject();
  const lastRun = activeFlowId ? nodeRuns[activeFlowId]?.[id] : undefined;

  // Guarded on the flow as well as the node, the same way `TestCanvas` builds its execution
  // view: another flow's run is someone else's graph, and a node id could collide across flows.
  const waiting = executingFlowId === activeFlowId && activeNodeId === id;

  const path = data.config?.awaitCallback?.path?.trim();
  const budgetMs = awaitTimeoutMs(data.config?.awaitCallback);
  // The alias wins, as everywhere else: an author who named this step meant the name to show.
  const title = data.alias?.trim() || data.label?.trim() || "Await callback";

  const elapsed = useElapsedSeconds(waiting);

  return (
    <div className="relative min-w-[180px] px-3 py-2 rounded-lg border-2 border-warning bg-warning/5 shadow-md hover:shadow-lg transition-shadow">
      {/* Running, as a pip on the corner — the same place, size and ring a test-case node uses,
          because "which node is going" should not be a different gesture per node type. Outside
          the flex row on purpose: in the row it widens the node, and nothing about a run may
          change a node's size. */}
      {waiting && (
        <span
          className="absolute -right-2 -top-2 flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-card bg-primary text-primary-foreground shadow-sm"
          title="Waiting for a callback"
          aria-label="waiting"
        >
          <Loader2 className="h-2.5 w-2.5 animate-spin motion-reduce:animate-none" />
        </span>
      )}

      <Handle id="target-top" type="target" position={Position.Top} className="!bg-warning" />
      <Handle id="target-left" type="target" position={Position.Left} className="!bg-warning" />

      <div className="flex items-center gap-1.5">
        <Hourglass className="w-3.5 h-3.5 text-warning shrink-0" aria-hidden="true" />
        <span className="text-xs font-semibold text-foreground truncate">{title}</span>
        <div className="flex-1" />
        {/* One slot, one width, whichever it is showing. A badge that grows when the run
            starts moves the node, and a column the author had lined up comes out staggered
            the moment it runs — the same reason the pip below sits outside this row. */}
        <span
          className={`w-[62px] shrink-0 text-right font-mono text-[10px] tabular-nums ${
            waiting ? "text-primary" : "text-warning"
          }`}
          title={
            waiting
              ? "Elapsed, against the timeout"
              : "How many callbacks it waits for, and for how long"
          }
          aria-label={
            waiting
              ? `Waiting ${elapsed} of ${Math.round(budgetMs / 1000)} seconds`
              : undefined
          }
        >
          {waiting
            ? `${elapsed}s / ${Math.round(budgetMs / 1000)}s`
            : awaitBadge(data.config?.awaitCallback)}
        </span>
      </div>

      {/* The path, or the reason it cannot run. Said on the node itself because a waiting step
          with no path is the one misconfiguration whose symptom — a minute of nothing — looks
          exactly like a sender that never called. */}
      {path ? (
        <div className="mt-1 text-[10px] font-mono text-muted-foreground truncate" title={path}>
          {path}
        </div>
      ) : (
        <div className="mt-1 text-[10px] text-destructive">no path set</div>
      )}

      {/* A finished run's reason. Suppressed while waiting, where the previous run's failure
          sitting under a live spinner reads as this one having already failed. */}
      {!waiting && lastRun?.error_message && (
        <div className="mt-1 text-[10px] text-destructive line-clamp-2" title={lastRun.error_message}>
          {lastRun.error_message}
        </div>
      )}

      <Handle id="source-bottom" type="source" position={Position.Bottom} className="!bg-warning" />
      <Handle id="source-right" type="source" position={Position.Right} className="!bg-warning" />
    </div>
  );
});

AwaitCallbackNode.displayName = "AwaitCallbackNode";

/**
 * Seconds since the wait began, or 0 when it is not waiting.
 *
 * Reset on the way *in* rather than on the way out, so a second run does not briefly show the
 * first one's total. One interval, owned by whichever node is actually waiting — at most one node
 * runs at a time, so this is one timer on the canvas and not one per node.
 */
function useElapsedSeconds(waiting: boolean): number {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!waiting) return;
    setSeconds(0);
    const started = Date.now();
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [waiting]);

  return waiting ? seconds : 0;
}
