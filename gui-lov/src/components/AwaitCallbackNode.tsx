import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { Hourglass } from "lucide-react";
import { useTestProject } from "@/contexts/TestProjectContext";
import { awaitBadge, type NodeConfig } from "@/lib/nodeConfig";

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
  const { activeFlowId, nodeRuns } = useTestProject();
  const lastRun = activeFlowId ? nodeRuns[activeFlowId]?.[id] : undefined;

  const path = data.config?.awaitCallback?.path?.trim();
  // The alias wins, as everywhere else: an author who named this step meant the name to show.
  const title = data.alias?.trim() || data.label?.trim() || "Await callback";

  return (
    <div className="min-w-[180px] px-3 py-2 rounded-lg border-2 border-warning bg-warning/5 shadow-md hover:shadow-lg transition-shadow">
      <Handle id="target-top" type="target" position={Position.Top} className="!bg-warning" />
      <Handle id="target-left" type="target" position={Position.Left} className="!bg-warning" />

      <div className="flex items-center gap-1.5">
        <Hourglass className="w-3.5 h-3.5 text-warning shrink-0" />
        <span className="text-xs font-semibold text-foreground truncate">{title}</span>
        <div className="flex-1" />
        <span
          className="text-[10px] font-mono text-warning shrink-0"
          title="How many callbacks it waits for, and for how long"
        >
          {awaitBadge(data.config?.awaitCallback)}
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

      {lastRun?.error_message && (
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
