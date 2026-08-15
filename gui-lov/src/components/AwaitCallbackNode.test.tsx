import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

/**
 * The waiting step on the canvas.
 *
 * The shared `exec-running` ring is a stylesheet concern, pinned in `lib/executionDecor.test.ts`.
 * This covers what belongs to this node alone: that while it waits it spins and counts, because a
 * ring that does not move answers neither "is this alive?" nor "how much longer?" over a minute.
 */

let ctx = {
  activeFlowId: "f1",
  executingFlowId: null as string | null,
  activeNodeId: null as string | null,
  nodeRuns: {} as Record<string, Record<string, unknown>>,
};
vi.mock("@/contexts/TestProjectContext", () => ({ useTestProject: () => ctx }));
// The node is rendered outside a React Flow provider, as its sibling test does.
vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
}));

import { AwaitCallbackNode } from "@/components/AwaitCallbackNode";

const node = (config: Record<string, unknown> = { awaitCallback: { path: "dr/x", timeoutMs: 60000 } }) => (
  <AwaitCallbackNode id="w1" data={{ alias: "Chk drCallback fires", config: config as never }} />
);

const waiting = () => {
  ctx = { ...ctx, executingFlowId: "f1", activeNodeId: "w1" };
};

beforeEach(() => {
  vi.useFakeTimers();
  ctx = { activeFlowId: "f1", executingFlowId: null, activeNodeId: null, nodeRuns: {} };
});
afterEach(() => vi.useRealTimers());

describe("while a step is waiting for a callback", () => {
  it("spins only while waiting", () => {
    const { container: idle } = render(node());
    expect(idle.querySelector(".animate-spin")).toBeNull();

    waiting();
    const { container: live } = render(node());
    expect(live.querySelector(".animate-spin")).not.toBeNull();
  });

  it("puts the spinner on the corner, where every other node puts it", () => {
    // It was inline in the header row first, and that read as a different kind of node rather
    // than the same node running: every other node shows a corner pip at -right-2 -top-2.
    waiting();
    const { container } = render(node());
    const pip = container.querySelector(".animate-spin")!.closest("span")!;
    expect(pip.className).toContain("absolute");
    expect(pip.className).toContain("-right-2");
    expect(pip.className).toContain("-top-2");
  });

  it("keeps the hourglass whatever it is doing, so the row never reflows", () => {
    // "Nothing about a run may change a node's size" — swapping the inline icon and growing the
    // badge both moved the node, and a column the author had lined up came out staggered the
    // moment it ran.
    waiting();
    const { container } = render(node());
    expect(container.querySelector(".lucide-hourglass")).not.toBeNull();
    const slot = [...container.querySelectorAll("span")].find((e) =>
      /^\d+s \/ \d+s$/.test((e.textContent || "").trim()),
    )!;
    expect(slot.className).toContain("w-[62px]");
  });

  it("counts the seconds against the budget", () => {
    // "Waiting" alone does not say whether this has ten seconds left or fifty.
    waiting();
    render(node());
    expect(screen.getByText("0s / 60s")).toBeInTheDocument();

    act(() => void vi.advanceTimersByTime(3000));
    expect(screen.getByText("3s / 60s")).toBeInTheDocument();
  });

  it("counts against the step's own timeout, not a fixed minute", () => {
    waiting();
    render(node({ awaitCallback: { path: "dr/x", timeoutMs: 20000 } }));
    expect(screen.getByText("0s / 20s")).toBeInTheDocument();
  });

  it("reads a cleared timeout as the default it will behave as", () => {
    waiting();
    render(node({ awaitCallback: { path: "dr/x", timeoutMs: 0 } }));
    expect(screen.getByText("0s / 60s")).toBeInTheDocument();
  });

  it("shows the configured badge again once it is not waiting", () => {
    render(node({ awaitCallback: { path: "dr/x", count: 2, timeoutMs: 45000 } }));
    expect(screen.getByText("2 · 45s")).toBeInTheDocument();
    expect(screen.queryByText(/0s \//)).not.toBeInTheDocument();
  });

  it("ignores a run belonging to another flow", () => {
    // Another flow's run is someone else's graph, and a node id could collide across flows.
    ctx = { ...ctx, executingFlowId: "f2", activeNodeId: "w1" };
    const { container } = render(node());
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("ignores a run where a different node is the live one", () => {
    ctx = { ...ctx, executingFlowId: "f1", activeNodeId: "someone-else" };
    const { container } = render(node());
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("hides the last run's failure while a new wait is in flight", () => {
    // A previous timeout sitting under a live spinner reads as this run having already failed.
    ctx = {
      activeFlowId: "f1",
      executingFlowId: "f1",
      activeNodeId: "w1",
      nodeRuns: { f1: { w1: { error_message: "no callback at dr/x within 60000ms" } } },
    };
    render(node());
    expect(screen.queryByText(/no callback at/)).not.toBeInTheDocument();
  });

  it("shows that failure once the run is over", () => {
    ctx = {
      activeFlowId: "f1",
      executingFlowId: null,
      activeNodeId: null,
      nodeRuns: { f1: { w1: { error_message: "no callback at dr/x within 60000ms" } } },
    };
    render(node());
    expect(screen.getByText(/no callback at/)).toBeInTheDocument();
  });

  it("keeps the count readable without animation", () => {
    // The spinner is decoration; the number is the information, and it has to survive
    // prefers-reduced-motion — which is why the count exists rather than a bare spinner.
    waiting();
    const { container } = render(node());
    expect(container.querySelector(".motion-reduce\\:animate-none")).not.toBeNull();
    expect(screen.getByText("0s / 60s")).toBeInTheDocument();
  });

  it("shows no denominator when it waits once per item", () => {
    // "70s / 60s" read as an overrun. It was the second item's wait, and the budget is per wait.
    waiting();
    render(node({ awaitCallback: { path: "dr/x", timeoutMs: 60000 }, forEach: { list: "launched" } }));
    act(() => void vi.advanceTimersByTime(70000));

    expect(screen.getByText("70s")).toBeInTheDocument();
    expect(screen.queryByText(/70s \/ 60s/)).not.toBeInTheDocument();
  });

  it("says in the tooltip why the count can pass the budget", () => {
    waiting();
    const { container } = render(
      node({ awaitCallback: { path: "dr/x", timeoutMs: 60000 }, forEach: { list: "launched" } }),
    );
    const slot = [...container.querySelectorAll("span")].find((e) =>
      /^\d+s$/.test((e.textContent || "").trim()),
    )!;
    expect(slot.getAttribute("title")).toMatch(/for each item/i);
  });

  it("keeps the denominator for a step that waits once", () => {
    waiting();
    render(node({ awaitCallback: { path: "dr/x", timeoutMs: 60000 } }));
    act(() => void vi.advanceTimersByTime(70000));
    expect(screen.getByText("70s / 60s")).toBeInTheDocument();
  });

});
