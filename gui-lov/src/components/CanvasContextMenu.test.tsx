/**
 * The canvas context menu.
 *
 * Two things happened here at once. "Add Test Entities" left, and an edge-type switcher arrived.
 *
 * The removal is not a simplification for its own sake: that section listed every flow in the
 * project (unbounded — thirteen made a menu taller than the viewport), its nested test cases never
 * rendered because `Flow.testCases` is hard-coded to `[]`, and the handler built a node with no
 * `testCaseId`, so it could not have worked even if they had. The sidebar does the same job with a
 * search box and carries the id.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CanvasContextMenu } from "@/components/CanvasContextMenu";

vi.mock("@/contexts/TestProjectContext", () => ({
  useTestProject: () => ({ addNodeToCanvas: vi.fn() }),
}));

const base = {
  x: 0,
  y: 0,
  canvasPosition: { x: 0, y: 0 },
  selectedNode: null,
  onClose: vi.fn(),
  onConfigureNode: vi.fn(),
};

describe("CanvasContextMenu on the canvas", () => {
  it("does not offer a second Start node, which validation refuses", () => {
    // Exactly one is required, so a second is a MULTIPLE_START_NODES error: the item's only
    // possible effect was to break the flow.
    render(<CanvasContextMenu {...base} />);
    expect(screen.queryByText(/start node/i)).not.toBeInTheDocument();
  });

  it("does offer another End node, because several are a real pattern", () => {
    // At least one is required and more are supported — Success to one End, Failure to another.
    // The Steps palette offers only awaitCallback, so this is the only way to add one.
    render(<CanvasContextMenu {...base} />);
    expect(screen.getByText(/add an end node/i)).toBeInTheDocument();
  });

  it("lists nothing that grows with the project", () => {
    render(<CanvasContextMenu {...base} />);
    expect(screen.queryByText(/add test entities/i)).not.toBeInTheDocument();
  });
});

describe("CanvasContextMenu on an edge", () => {
  const onSetEdgeType = vi.fn();
  const openOn = (data?: Record<string, unknown>) => {
    onSetEdgeType.mockClear();
    render(
      <CanvasContextMenu
        {...base}
        selectedEdge={{ id: "e2", data }}
        onSetEdgeType={onSetEdgeType}
      />,
    );
  };

  it("shows only the three kinds — the canvas items do not apply to an edge", () => {
    openOn({ type: "any" });
    expect(screen.getByText("Success")).toBeInTheDocument();
    expect(screen.getByText("Failure")).toBeInTheDocument();
    expect(screen.getByText("Always")).toBeInTheDocument();
    expect(screen.queryByText("Start Node")).not.toBeInTheDocument();
  });

  it("marks the kind the edge already is, and will not re-apply it", () => {
    // "Which one is it now" is the first question this menu answers.
    openOn({ type: "any" });
    const current = screen.getByRole("menuitem", { name: /Always/ });
    expect(current).toBeDisabled();
    expect(current).toHaveAttribute("aria-current", "true");
  });

  it("switches to another kind in one click, instead of delete-and-redraw", () => {
    openOn({ type: "failure" });
    return userEvent.click(screen.getByRole("menuitem", { name: /Always/ })).then(() => {
      expect(onSetEdgeType).toHaveBeenCalledWith("any");
    });
  });

  it("says what an untyped edge is, since that is not one of the three", () => {
    // Nearly every edge in an existing flow is untyped, and a menu with nothing marked would read
    // as a selection that failed to load.
    openOn(undefined);
    expect(screen.getByText(/untyped — taken on a pass, never on a failure/i)).toBeInTheDocument();
    for (const kind of ["Success", "Failure", "Always"]) {
      expect(screen.getByRole("menuitem", { name: new RegExp(kind) })).toBeEnabled();
    }
  });
});
