import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * `?flow=<id>` in the URL.
 *
 * Rendered through the real provider rather than tested as a pure function, because the bug was a
 * *missing call*: the selection was restored and the tab was never opened, so a pasted link landed
 * on the welcome pane with the project loaded around it. Nothing short of rendering can see that.
 */

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { TestProjectProvider, useTestProject } from "@/contexts/TestProjectContext";

/** What the main pane actually keys off: the open tabs, and which is active. */
const Probe = () => {
  const { workspace, activeFlowId, openFlowOnCanvas, closeWorkspaceTab } = useTestProject();
  return (
    <div>
      <span data-testid="tabs">{workspace.tabs.map((t) => `${t.kind}:${t.id}`).join(",")}</span>
      <span data-testid="active">{workspace.active ?? "none"}</span>
      <span data-testid="selected">{activeFlowId ?? "none"}</span>
      <button onClick={() => openFlowOnCanvas("f1")}>open f1</button>
      <button onClick={() => openFlowOnCanvas("f2")}>open f2</button>
      <button onClick={() => closeWorkspaceTab(workspace.active!)}>close active</button>
      <button onClick={() => closeWorkspaceTab("flow:f1")}>close f1</button>
    </div>
  );
};

const flow = (id: string, name: string) => ({
  id,
  project_id: "p1",
  name,
  description: null,
  graph_data: { nodes: [], edges: [], canvas_settings: {}, variables: {} },
  version: 1,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
});

const renderAt = (url: string, flows = [flow("f1", "First"), flow("f2", "Second")]) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <TestProjectProvider projectId="p1" initialFlows={flows as never}>
          <Probe />
        </TestProjectProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => vi.clearAllMocks());

describe("landing on a link that names a flow", () => {
  it("opens the flow as a tab, not just selects it", () => {
    // The whole bug. `activeFlowId` was set and `workspace.tabs` was left empty, so the pane that
    // renders from tabs showed "Build a request" while the sidebar showed the project.
    renderAt("/project/p1?flow=f2");
    expect(screen.getByTestId("tabs").textContent).toBe("flow:f2");
    expect(screen.getByTestId("active").textContent).toBe("flow:f2");
    expect(screen.getByTestId("selected").textContent).toBe("f2");
  });

  it("opens it even when the linked flow is the first in the list", () => {
    // The case the old `!== activeFlowId` guard could never have caught: the "select the first
    // flow" effect had already set it, the ids matched, and nothing opened. Whether a link worked
    // depended on where its flow sat in the list.
    renderAt("/project/p1?flow=f1");
    expect(screen.getByTestId("tabs").textContent).toBe("flow:f1");
  });

  it("opens nothing when the link names a flow that no longer exists", () => {
    // A stale link. Quieter to ignore than to open an empty canvas claiming to be a flow.
    renderAt("/project/p1?flow=deleted");
    expect(screen.getByTestId("tabs").textContent).toBe("");
  });

  it("opens nothing when the link names no flow", () => {
    renderAt("/project/p1");
    expect(screen.getByTestId("tabs").textContent).toBe("");
  });

  it("selects the first flow but leaves the workspace closed without a link", () => {
    // Landing on a project is not landing on a flow: the welcome pane is right here, and the
    // author picks. Only an explicit ?flow= opens one.
    renderAt("/project/p1");
    expect(screen.getByTestId("selected").textContent).toBe("f1");
    expect(screen.getByTestId("active").textContent).toBe("none");
  });
});

/**
 * Closing a tab.
 *
 * The same shape of bug as the deep link above, and the reason this file is rendered rather than
 * unit-tested: closing picks a new active tab, and the pane that draws the canvas keys off
 * `activeFlowId` instead. Set one and not the other and the strip names one flow while the canvas
 * draws another — with the title bar siding with the canvas, so it reads as the tab being wrong.
 */
describe("closing the active flow tab", () => {
  const openTwo = async () => {
    renderAt("/project/p1");
    await userEvent.click(screen.getByText("open f1"));
    await userEvent.click(screen.getByText("open f2"));
    expect(screen.getByTestId("tabs").textContent).toBe("flow:f1,flow:f2");
    expect(screen.getByTestId("selected").textContent).toBe("f2");
  };

  it("moves the canvas to the tab that takes its place", async () => {
    // The whole bug: the tab vanished, the neighbour became active, and the canvas kept drawing
    // the flow that had just been closed.
    await openTwo();
    await userEvent.click(screen.getByText("close active"));
    expect(screen.getByTestId("tabs").textContent).toBe("flow:f1");
    expect(screen.getByTestId("active").textContent).toBe("flow:f1");
    expect(screen.getByTestId("selected").textContent).toBe("f1");
  });

  it("leaves the canvas alone when the closed tab was not the active one", async () => {
    await openTwo();
    await userEvent.click(screen.getByText("close f1"));
    expect(screen.getByTestId("tabs").textContent).toBe("flow:f2");
    expect(screen.getByTestId("selected").textContent).toBe("f2");
  });

  it("keeps the last flow selected when the last tab closes", async () => {
    // Nothing is on screen to disagree with — the welcome pane is showing — and the flow the
    // author was last on is the right one to come back to.
    renderAt("/project/p1");
    await userEvent.click(screen.getByText("open f2"));
    await userEvent.click(screen.getByText("close active"));
    expect(screen.getByTestId("tabs").textContent).toBe("");
    expect(screen.getByTestId("selected").textContent).toBe("f2");
  });
});
