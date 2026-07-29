/**
 * The controls for a run the author is driving a node at a time.
 *
 * Floats over the top of the canvas rather than joining the toolbar: the toolbar
 * already squeezes its own buttons off the edge on a narrow window, and this belongs
 * next to the graph it is stepping through.
 */
import { StepForward, FastForward, Square, Pause, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RunMode, StepCommand } from "@/hooks/useExecutionStream";

interface StepControlsProps {
  mode: RunMode;
  /** What the paused run is waiting to run, named for the author. */
  nextNodeName: string | null;
  /** How many nodes have finished, and how many there are. */
  done: number;
  total: number;
  onStep: (command: StepCommand) => void;
}

export function StepControls({ mode, nextNodeName, done, total, onStep }: StepControlsProps) {
  // Only a stepped run has anything to press. A plain run reaches 'finishing'
  // immediately and never shows this.
  if (mode !== "paused" && mode !== "running") return null;

  const paused = mode === "paused";

  return (
    <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2">
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card/95 px-3 py-2 shadow-lg backdrop-blur">
        <div className="flex items-center gap-2 text-sm">
          {paused ? (
            <Pause className="h-4 w-4 shrink-0 text-primary" />
          ) : (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
          )}
          <span className="text-muted-foreground">
            {paused ? "Next up" : "Running"}
          </span>
          {nextNodeName && (
            <span className="max-w-[16rem] truncate font-medium" title={nextNodeName}>
              {nextNodeName}
            </span>
          )}
          {total > 0 && (
            <span className="tabular-nums text-xs text-muted-foreground">
              {done} of {total} done
            </span>
          )}
        </div>

        <div className="h-5 w-px bg-border" />

        <div className="flex items-center gap-1">
          <Button size="sm" className="h-7 gap-1.5 px-2.5" disabled={!paused} onClick={() => onStep("next")}>
            <StepForward className="h-3.5 w-3.5" /> Next
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2.5"
            disabled={!paused}
            onClick={() => onStep("run_to_end")}
            title="Finish the flow without pausing again"
          >
            <FastForward className="h-3.5 w-3.5" /> Run to end
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2.5"
            disabled={!paused}
            onClick={() => onStep("stop")}
            // Says what actually happens. Cleanup nodes are not optional, and a
            // request already in flight finishes.
            title="Stop after this node. Cleanup steps still run."
          >
            <Square className="h-3.5 w-3.5" /> Stop
          </Button>
        </div>
      </div>
    </div>
  );
}
