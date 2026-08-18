import { CheckCircle, XCircle, ArrowDown, Check } from "lucide-react";
import { EDGE_LABEL, type EdgeKind } from "@/lib/api/types";
import { useTestProject } from "@/contexts/TestProjectContext";

/**
 * The three kinds an edge can be, in the order the dialog lists them: the two verdicts, then the
 * one that ignores them. Icons and tints match the dialog and the edge colours, so the same idea
 * looks the same wherever it appears.
 */
const EDGE_KINDS: { kind: EdgeKind; icon: typeof CheckCircle; tint: string; note: string }[] = [
  { kind: "success", icon: CheckCircle, tint: "text-success", note: "only when it passes" },
  { kind: "failure", icon: XCircle, tint: "text-destructive", note: "only when it fails" },
  { kind: "any", icon: ArrowDown, tint: "text-muted-foreground", note: "whatever it does" },
];

interface CanvasContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  canvasPosition: { x: number; y: number };
  selectedNode: any | null;
  onConfigureNode: () => void;
  /** The edge that was right-clicked, if the menu was opened on one. */
  selectedEdge?: { id: string; data?: Record<string, unknown> } | null;
  onSetEdgeType?: (type: EdgeKind) => void;
}

export const CanvasContextMenu = ({
  x,
  y,
  onClose,
  canvasPosition,
  selectedNode,
  onConfigureNode,
  selectedEdge,
  onSetEdgeType,
}: CanvasContextMenuProps) => {
  const { addNodeToCanvas } = useTestProject();

  const handleAddNode = (type: 'start' | 'end', label: string) => {
    addNodeToCanvas(type, { label }, canvasPosition);
    onClose();
  };

  /**
   * An edge's own menu. Nothing else in it applies — you did not right-click the canvas to add a
   * Start node to it — so this is the whole menu when an edge is the target.
   *
   * Changing the type in place, rather than delete-and-redraw, which was the only way before:
   * losing the edge to change one word about it. The current kind is marked and inert; the others
   * are one click.
   */
  if (selectedEdge) {
    const current = (selectedEdge.data?.type as EdgeKind | undefined) ?? undefined;
    return (
      <>
        <div className="fixed inset-0 z-40" onClick={onClose} />
        <div
          className="fixed z-50 bg-card border border-border rounded-lg shadow-lg py-1 min-w-[240px]"
          style={{ left: x, top: y }}
          role="menu"
        >
          <div className="px-3 py-1.5 text-xs text-muted-foreground font-medium">
            Take this connection
          </div>
          {EDGE_KINDS.map(({ kind, icon: Icon, tint, note }) => {
            const isCurrent = current === kind;
            return (
              <button
                key={kind}
                role="menuitem"
                aria-current={isCurrent}
                disabled={isCurrent}
                onClick={() => {
                  onSetEdgeType?.(kind);
                  onClose();
                }}
                className={`w-full px-3 py-2 text-left text-sm transition-colors flex items-center gap-2 ${
                  isCurrent ? "bg-muted/40 cursor-default" : "hover:bg-muted/50"
                }`}
              >
                <Icon className={`w-3 h-3 ${tint}`} />
                <span className="font-medium">{EDGE_LABEL[kind]}</span>
                <span className="text-xs text-muted-foreground">{note}</span>
                {/* A tick rather than a disabled look alone: "which one is it now" is the first
                    question this menu answers, and an untyped edge answers it with none of them. */}
                {isCurrent && <Check className="w-3 h-3 ml-auto text-muted-foreground" />}
              </button>
            );
          })}
          {!current && (
            <p className="px-3 pt-1 pb-1.5 text-[11px] text-muted-foreground">
              {/* Most edges in an existing flow are untyped, and that is not one of the three: it
                  is taken on a pass or a skip and never on a failure. Saying so here beats leaving
                  the menu looking like nothing is selected by mistake. */}
              Untyped — taken on a pass, never on a failure.
            </p>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
      />
      <div
        className="fixed z-50 bg-card border border-border rounded-lg shadow-lg py-1 min-w-[200px]"
        style={{ left: x, top: y }}
      >
        {selectedNode && selectedNode.type !== 'start' && selectedNode.type !== 'end' && (
          <>
            <button
              onClick={onConfigureNode}
              className="w-full px-3 py-2 text-left text-sm hover:bg-muted/50 transition-colors font-medium"
            >
              Configure Node
            </button>
            <div className="border-t border-border/50 my-1" />
          </>
        )}

        {/*
          "Start Node" was here and is gone: validation requires **exactly one**, so a second is a
          `MULTIPLE_START_NODES` error. The menu's only effect was to offer a way to break the flow.

          "End Node" stays, and the reason is the opposite: validation requires *at least* one, and
          several are a real pattern — Success to one End, Failure to another, which is how the
          engine's own routing test is built. This is also the only way to add one: the Steps
          palette offers `awaitCallback` alone, and a flow is created with a single End.
        */}
        <button
          onClick={() => handleAddNode('end', 'End')}
          className="w-full px-3 py-2 text-left text-sm hover:bg-muted/50 transition-colors flex items-center gap-2"
        >
          <CheckCircle className="w-3 h-3 text-primary" />
          <span>Add an End node</span>
          <span className="ml-auto text-xs text-muted-foreground">for a second exit</span>
        </button>

        {/*
          "Add Test Entities" was here, listing every flow in the project and, nested under each,
          its test cases. It is gone for three reasons, in ascending order of severity:

          1. It could not scale. Thirteen flows made a menu taller than the viewport, and the list
             is unbounded by construction.
          2. The nested test cases never appeared. `Flow.testCases` is hard-coded to `[]` for every
             flow loaded from the API, so that half of the menu had always rendered nothing.
          3. It could not have worked if they had. `handleAddTestCase` built the node with a label,
             a method and an endpoint but **no `testCaseId`** — so the node would have been bound to
             no request and could not run.

          The sidebar already does this properly and with a search box: `TestInventory` rows and
          `FlowsList` rows are both draggable onto the canvas, and both carry the id.
        */}
      </div>
    </>
  );
};
