import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Node } from "@xyflow/react";

const updateNodeConfig = vi.fn();
vi.mock("@/contexts/TestProjectContext", () => ({
  useTestProject: () => ({ updateNodeConfig, projectId: "p1" }),
}));
const rows = [
  { id: "r1", name: "happy path", body: '{"a":1}', check: "201" },
  { id: "r2", name: "no balance", body: '{"a":2}', check: "402" },
];
let datasetRows: typeof rows | undefined = rows;
vi.mock("@/hooks/useApi", () => ({
  useTestCases: () => ({
    data: [
      {
        id: "tc1",
        name: "Delete User (renamed)",
        method: "DELETE",
        endpoint: "/accounts/{{id}}",
        ...(datasetRows ? { dataset: { rows: datasetRows } } : {}),
      },
    ],
  }),
}));

import { NodeConfigPanel } from "@/components/NodeConfigPanel";

const node = (config: Record<string, unknown> = {}): Node => ({
  id: "n1",
  type: "testCase",
  position: { x: 0, y: 0 },
  data: {
    testCaseId: "tc1",
    label: "Delete User",
    method: "DELETE",
    endpoint: "{{baseUrl}}/accounts/{{id}}",
    config,
  },
});

describe("NodeConfigPanel", () => {
  beforeEach(() => {
    updateNodeConfig.mockReset();
    datasetRows = rows;
  });

  it("saves the Runs choice as the flag the engine reads", async () => {
    render(<NodeConfigPanel node={node()} onClose={vi.fn()} />);

    // Defaults to running in the flow, where it was placed.
    await userEvent.click(screen.getByRole("radio", { name: /at the end/i }));
    await userEvent.click(screen.getByRole("button", { name: /save configuration/i }));

    const [, config] = updateNodeConfig.mock.calls[0];
    expect(config.teardown).toBe(true);
  });

  it("reads an existing teardown node back as At the end", () => {
    render(<NodeConfigPanel node={node({ teardown: true })} onClose={vi.fn()} />);
    expect(screen.getByRole("radio", { name: /at the end/i })).toHaveAttribute(
      "data-state",
      "on",
    );
  });

  it("explains Expect according to what is in it", async () => {
    render(<NodeConfigPanel node={node()} onClose={vi.fn()} />);
    expect(screen.getByText(/blank uses the request's own assertion/i)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/^expect$/i), "402");
    expect(screen.getByText(/shorthand for response.status == 402/i)).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText(/^expect$/i));
    await userEvent.type(screen.getByLabelText(/^expect$/i), "response.json.ok");
    expect(screen.getByText(/rhai expression/i)).toBeInTheDocument();
  });

  it("shows the request's current name, not the one stored when the node was made", () => {
    // A renamed test case used to keep showing its old name here while the canvas
    // showed the new one — the two disagreeing about the same node.
    render(<NodeConfigPanel node={node()} onClose={vi.fn()} />);
    expect(screen.getByText("Delete User (renamed)")).toBeInTheDocument();
    expect(screen.queryByText("Delete User")).not.toBeInTheDocument();
  });

  it("stores every row as an absent list, not an empty one", async () => {
    // Absence means "all", so a row added to the dataset later is included without
    // anyone reopening this node.
    render(<NodeConfigPanel node={node()} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("radio", { name: /once per row/i }));
    await userEvent.click(screen.getByRole("button", { name: /save configuration/i }));

    const [, config] = updateNodeConfig.mock.calls[0];
    expect(config.forEachRow).toBe(true);
    expect("rowIds" in config).toBe(false);
  });

  it("saves only the rows that are ticked", async () => {
    render(<NodeConfigPanel node={node()} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("radio", { name: /once per row/i }));
    await userEvent.click(screen.getByRole("checkbox", { name: /run no balance/i }));
    await userEvent.click(screen.getByRole("button", { name: /save configuration/i }));

    const [, config] = updateNodeConfig.mock.calls[0];
    expect(config.rowIds).toEqual(["r1"]);
  });

  it("reads an existing selection back", () => {
    render(<NodeConfigPanel node={node({ forEachRow: true, rowIds: ["r2"] })} onClose={vi.fn()} />);
    expect(screen.getByRole("radio", { name: /once per row/i })).toHaveAttribute("data-state", "on");
    expect(screen.getByRole("checkbox", { name: /run happy path/i })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /run no balance/i })).toBeChecked();
    expect(screen.getByText(/1 of 2 rows run here/i)).toBeInTheDocument();
  });

  it("won't offer per-row for a request with no rows", () => {
    datasetRows = undefined;
    render(<NodeConfigPanel node={node()} onClose={vi.fn()} />);
    expect(screen.getByRole("radio", { name: /once per row/i })).toBeDisabled();
    expect(screen.getByText(/no data rows/i)).toBeInTheDocument();
  });

  it("names selected rows that no longer exist, and can drop them", async () => {
    render(<NodeConfigPanel node={node({ forEachRow: true, rowIds: ["r1", "gone"] })} onClose={vi.fn()} />);
    expect(screen.getByText(/no longer exist/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /remove them/i }));
    await userEvent.click(screen.getByRole("button", { name: /save configuration/i }));
    expect(updateNodeConfig.mock.calls[0][1].rowIds).toEqual(["r1"]);
  });

  it("says what an empty selection will do, rather than refusing the click", async () => {
    render(<NodeConfigPanel node={node({ forEachRow: true, rowIds: ["r1"] })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("checkbox", { name: /run happy path/i }));
    expect(screen.getByText(/will fail without sending anything/i)).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<NodeConfigPanel node={node()} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
