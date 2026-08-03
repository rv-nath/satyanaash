import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TestCaseExecutionResult } from "@/lib/api/types";

let nodeRuns: Record<string, Record<string, TestCaseExecutionResult>> = {};
let activeNodeId: string | null = null;
vi.mock("@/contexts/TestProjectContext", () => ({
  useTestProject: () => ({ projectId: "p1", activeFlowId: "f1", nodeRuns, activeNodeId }),
}));
vi.mock("@/hooks/useApi", () => ({
  useTestCases: () => ({
    data: [{ id: "tc1", name: "Login", method: "POST", endpoint: "/login" }],
  }),
}));
vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
}));

import { TestCaseNode } from "@/components/TestCaseNode";

const result = (over: Partial<TestCaseExecutionResult> = {}) =>
  ({
    node_id: "n1",
    test_case_name: "Login",
    status: "passed",
    duration_ms: 107,
    ...over,
  }) as TestCaseExecutionResult;

const renderNode = (config?: Record<string, unknown>) =>
  render(
    <TestCaseNode
      id="n1"
      data={{ label: "Login", method: "POST", testCaseId: "tc1", config }}
    />,
  );

describe("TestCaseNode last run", () => {
  beforeEach(() => {
    nodeRuns = {};
    activeNodeId = null;
  });

  it("says nothing about a run before there has been one", async () => {
    renderNode();
    await userEvent.click(screen.getByRole("button", { name: /request details/i }));
    expect(screen.queryByText(/last run/i)).not.toBeInTheDocument();
  });

  it("reports the verdict and what the node handed on", async () => {
    const jwt = "eyJhbGciOiJSUzI1".padEnd(2474, "x");
    nodeRuns = { f1: { n1: result({ exports: { my_jwt: jwt } }) } };
    renderNode();

    // On the node itself, so it survives a screenshot and a colour-blind reader.
    expect(screen.getByTitle(/last run: passed in 107ms/i)).toHaveTextContent("✓");

    await userEvent.click(screen.getByRole("button", { name: /request details/i }));
    expect(screen.getByText(/passed/)).toBeInTheDocument();
    expect(screen.getByText(/107ms/)).toBeInTheDocument();
    // Cut short rather than filling the popover with a 2.5KB token.
    expect(screen.getByText(/my_jwt = eyJhbGciOiJSUzI1/)).toHaveTextContent("(2474 chars)");
  });

  it("keeps the verdict out of the layout, so a run can't resize the node", async () => {
    // It used to sit in the node's flex row, which widened it — and only the nodes
    // below max-width, so a column the author had centred came out staggered the
    // moment it ran. jsdom does no layout, so this pins the mechanism: the badge is
    // absolutely positioned, and the node's own classes are unchanged by a result.
    const { container, unmount } = renderNode();
    const before = (container.firstElementChild as HTMLElement).className;
    unmount();

    nodeRuns = { f1: { n1: result() } };
    const after = renderNode();
    expect((after.container.firstElementChild as HTMLElement).className).toBe(before);
    expect(screen.getByTitle(/last run: passed/i).className).toContain("absolute");
  });

  it("shows a failure as a failure", async () => {
    nodeRuns = { f1: { n1: result({ status: "failed" }) } };
    renderNode();
    expect(screen.getByTitle(/last run: failed/i)).toHaveTextContent("✗");
  });

  it("counts rows for a node that ran one request per row", async () => {
    nodeRuns = {
      f1: {
        n1: result({
          iterations: [
            result({ status: "passed" }),
            result({ status: "failed" }),
            result({ status: "skipped" }),
          ],
        }),
      },
    };
    renderNode();
    await userEvent.click(screen.getByRole("button", { name: /request details/i }));
    // Skipped rows are out of the denominator, not counted as failures.
    expect(screen.getByText(/1\/2 rows passed/)).toBeInTheDocument();
  });

  it("shows a node in flight as running, not as its previous verdict", async () => {
    nodeRuns = { f1: { n1: result({ status: "failed" }) } };
    activeNodeId = "n1";
    renderNode();
    expect(screen.getByLabelText("running")).toBeInTheDocument();
    expect(screen.queryByTitle(/last run: failed/i)).not.toBeInTheDocument();
  });

  it("wraps a long name instead of hiding the end of it", () => {
    // The node is capped at a max width; past that the name used to be cut off with an
    // ellipsis, so two nodes running different tests could read identically on the
    // canvas. It grows downwards now.
    renderNode();
    const label = screen.getByText("Login");
    expect(label.className).toContain("break-words");
    expect(label.className).not.toContain("truncate");
  });

  it("ignores another flow's results", async () => {
    nodeRuns = { f2: { n1: result() } };
    renderNode();
    expect(screen.queryByTitle(/last run/i)).not.toBeInTheDocument();
  });
});

describe("a node that polls", () => {
  beforeEach(() => {
    nodeRuns = {};
    activeNodeId = null;
  });

  it("says so on the canvas", async () => {
    // A step that can take two minutes must not look exactly like one that takes 40ms —
    // the badge is the only thing that says the graph has a wait in it.
    renderNode({ poll: { until: 'response.json.status != "pending"', intervalMs: 2000, timeoutMs: 120000 } });
    const badge = screen.getByText("polls");
    expect(badge).toHaveAttribute(
      "title",
      expect.stringContaining("every 2s for up to 2m"),
    );

    await userEvent.click(screen.getByRole("button", { name: /request details/i }));
    expect(screen.getByText(/response\.json\.status != "pending"/)).toBeInTheDocument();
  });

  it("says nothing when there is no condition to wait for", () => {
    // An interval with no `until` is not polling — in the engine or here. Badging it
    // would claim a behaviour the node does not have.
    renderNode({ poll: { intervalMs: 5000 } });
    expect(screen.queryByText("polls")).not.toBeInTheDocument();

    renderNode({});
    expect(screen.queryByText("polls")).not.toBeInTheDocument();
  });

  it("reports the attempts a duration cannot account for", async () => {
    nodeRuns = { f1: { n1: result({ attempts: 3, duration_ms: 4200 }) } };
    renderNode({ poll: { until: "x" } });

    await userEvent.click(screen.getByRole("button", { name: /request details/i }));
    expect(screen.getByText(/3 attempts · 4\.2s/)).toBeInTheDocument();
  });
});
