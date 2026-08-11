import { Hourglass } from "lucide-react";

/**
 * Steps that are not test cases, to drag onto the canvas.
 *
 * There was no palette before this: test cases came from the list below, flows came from the
 * flows rail, and start/end were seeded with the flow. A control node had nowhere to come from.
 *
 * It rides the same channel the other two drags already use — `application/json` carrying
 * `{type, data}` — so `handleDrop` and `addNodeToCanvas` took it unchanged, and the undo history
 * treats it like any other added node. A toolbar button would have needed its own path to the
 * canvas and its own idea of where to drop.
 */
export const StepPalette = () => {
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(
      "application/json",
      JSON.stringify({
        type: "awaitCallback",
        data: {
          label: "Await callback",
          // Defaults that match the engine's, so a freshly dropped node shows what it will
          // actually do rather than blanks that read as "unset" and behave as 1 and 60s.
          config: { awaitCallback: { count: 1, timeoutMs: 60000 } },
        },
      }),
    );
  };

  return (
    <div className="px-2 pb-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-1 pb-1">
        Steps
      </div>
      <div
        draggable
        onDragStart={handleDragStart}
        title="Drag onto the canvas — waits for an inbound callback, such as a delivery report"
        className="flex items-center gap-1.5 px-2 py-1.5 rounded border border-warning/40 bg-warning/5 cursor-grab active:cursor-grabbing hover:bg-warning/10 transition-colors"
      >
        <Hourglass className="w-3.5 h-3.5 text-warning shrink-0" />
        <span className="text-xs text-foreground">Await callback</span>
      </div>
    </div>
  );
};
