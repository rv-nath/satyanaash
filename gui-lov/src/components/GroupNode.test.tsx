import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The step that runs another flow.
 *
 * Everything on it is a roll-up: its steps are spliced into the parent graph before the run, so
 * the run reports under ids that name no node on the canvas and this node has no result of its
 * own. The arithmetic lives in `lib/executionDecor.test.ts`; this covers what only a render can
 * show — that the node reads the map at all, and that its verdict is not blank while four of its
 * steps pass and one fails.
 */

const SEP = "\u001F";
const openFlowTab = vi.fn();

let ctx = {
  flows: [] as { id: string; name: string; internalNodes?: { type: string }[] }[],
  activeFlowId: "f1" as string | null,
  executingFlowId: null as string | null,
  nodeRuns: {} as Record<string, Record<string, { status: string }>>,
  inlinedByFlow: {} as Record<string, unknown[]>,
  activeNodeId: null as string | null,
  pausedNodeId: null as string | null,
  openFlowTab,
};

vi.mock("@/contexts/TestProjectContext", () => ({ useTestProject: () => ctx }));
vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
}));

import { GroupNode } from "@/components/GroupNode";

const onboarding = {
  group_node_id: "g1",
  flow_id: "sub",
  flow_name: "Onboard an enterprise",
  node_ids: [`g1${SEP}signup`, `g1${SEP}otp`, `g1${SEP}login`],
};

const node = (data: Record<string, unknown> = { flowId: "sub", label: "stale name" }) => (
  <GroupNode id="g1" data={data as never} />
);

beforeEach(() => {
  openFlowTab.mockClear();
  ctx = {
    flows: [
      {
        id: "sub",
        name: "Onboard an enterprise",
        internalNodes: [
          { type: "start" },
          { type: "testCase" },
          { type: "testCase" },
          { type: "end" },
        ],
      },
    ],
    activeFlowId: "f1",
    executingFlowId: null,
    nodeRuns: {},
    inlinedByFlow: {},
    activeNodeId: null,
    pausedNodeId: null,
    openFlowTab,
  };
});

describe("a sub-flow node at rest", () => {
  it("shows the flow's current name, not the one saved on the node", () => {
    // `data.label` is a snapshot from when the node was dropped. Renaming the flow used to
    // leave every node that runs it showing the old name.
    render(node());
    expect(screen.getByText("Onboard an enterprise")).toBeInTheDocument();
    expect(screen.queryByText("stale name")).not.toBeInTheDocument();
  });

  it("counts the steps it will contribute", () => {
    // It said "0 test cases" on every node ever created: the count was hard-coded to 0.
    render(node());
    expect(screen.getByText("2 steps")).toBeInTheDocument();
  });

  it("says a missing flow will stop the run, because now it does", () => {
    // A node pointing at a deleted flow used to be a silent no-op and the run "succeeded".
    ctx = { ...ctx, flows: [] };
    render(node());
    expect(screen.getByText(/flow not found/i)).toBeInTheDocument();
  });

  it("opens the flow it runs, rather than a modal whose edits were never saved", async () => {
    render(node());
    await userEvent.dblClick(screen.getByText("Onboard an enterprise"));
    expect(openFlowTab).toHaveBeenCalledWith("sub", true);
  });
});

describe("a sub-flow node during a run", () => {
  const withRun = (over: Partial<typeof ctx>) => {
    ctx = { ...ctx, executingFlowId: "f1", inlinedByFlow: { f1: [onboarding] }, ...over };
  };

  it("spins while one of its steps is in flight", () => {
    // The node_started event names an inner id. Without the roll-up nothing on the canvas moves
    // for the whole time a sub-flow runs.
    withRun({ activeNodeId: `g1${SEP}otp` });
    const { container } = render(node());
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("wears the worst verdict of the steps it stands for", () => {
    withRun({
      executingFlowId: null,
      nodeRuns: {
        f1: {
          [`g1${SEP}signup`]: { status: "passed" },
          [`g1${SEP}otp`]: { status: "failed" },
        },
      },
    });
    const { container } = render(node());
    const pip = container.querySelector('[aria-label="failed"]');
    expect(pip).not.toBeNull();
  });

  it("says how far it got and how many failed, which one verdict cannot", () => {
    withRun({
      executingFlowId: null,
      nodeRuns: {
        f1: {
          [`g1${SEP}signup`]: { status: "passed" },
          [`g1${SEP}otp`]: { status: "failed" },
        },
      },
    });
    render(node());
    expect(screen.getByText(/2 of 3 steps/)).toBeInTheDocument();
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
  });

  it("keeps its verdict after the run ends", () => {
    // `nodeRuns` outlives the run, and so must the map — otherwise this is the one node on the
    // canvas whose result disappears the moment the run finishes.
    ctx = {
      ...ctx,
      executingFlowId: null,
      inlinedByFlow: { f1: [onboarding] },
      nodeRuns: { f1: { [`g1${SEP}signup`]: { status: "passed" } } },
    };
    const { container } = render(node());
    expect(container.querySelector('[aria-label="passed"]')).not.toBeNull();
  });

  it("ignores a run belonging to another flow", () => {
    ctx = { ...ctx, executingFlowId: "f2", activeNodeId: `g1${SEP}otp`, inlinedByFlow: { f1: [onboarding] } };
    const { container } = render(node());
    expect(container.querySelector(".animate-spin")).toBeNull();
  });
});
