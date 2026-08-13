import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Node } from "@xyflow/react";

const updateNodeConfig = vi.fn();
// A graph with one upstream step that collects into "launched", so the panel has something
// real to offer when asked which list to walk.
const graphNodes = [
  { id: "up", type: "testCase", data: { config: { forEachRow: true, collect: { into: "launched" } } } },
  { id: "n1", type: "testCase", data: {} },
];
const graphEdges = [{ id: "e1", source: "up", target: "n1" }];
vi.mock("@/contexts/TestProjectContext", () => ({
  useTestProject: () => ({
    updateNodeConfig,
    projectId: "p1",
    nodes: graphNodes,
    edges: graphEdges,
  }),
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
    await userEvent.click(screen.getByRole("radio", { name: /once per data row/i }));
    await userEvent.click(screen.getByRole("button", { name: /save configuration/i }));

    const [, config] = updateNodeConfig.mock.calls[0];
    expect(config.forEachRow).toBe(true);
    expect("rowIds" in config).toBe(false);
  });

  it("saves only the rows that are ticked", async () => {
    render(<NodeConfigPanel node={node()} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("radio", { name: /once per data row/i }));
    await userEvent.click(screen.getByRole("checkbox", { name: /run no balance/i }));
    await userEvent.click(screen.getByRole("button", { name: /save configuration/i }));

    const [, config] = updateNodeConfig.mock.calls[0];
    expect(config.rowIds).toEqual(["r1"]);
  });

  it("reads an existing selection back", () => {
    render(<NodeConfigPanel node={node({ forEachRow: true, rowIds: ["r2"] })} onClose={vi.fn()} />);
    expect(screen.getByRole("radio", { name: /once per data row/i })).toHaveAttribute("data-state", "on");
    expect(screen.getByRole("checkbox", { name: /run happy path/i })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /run no balance/i })).toBeChecked();
    expect(screen.getByText(/1 of 2 rows run here/i)).toBeInTheDocument();
  });

  it("won't offer per-row for a request with no rows", () => {
    datasetRows = undefined;
    render(<NodeConfigPanel node={node()} onClose={vi.fn()} />);
    expect(screen.getByRole("radio", { name: /once per data row/i })).toBeDisabled();
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

describe("collecting what each run produced", () => {
  beforeEach(() => {
    updateNodeConfig.mockReset();
    datasetRows = rows;
  });

  it("asks where to put the captures only once a step runs more than once", async () => {
    // A step that runs once exports scalars under their own names — there is no record and
    // nothing to name, so the field would be a question with no meaning.
    render(<NodeConfigPanel node={node()} onClose={vi.fn()} />);
    expect(screen.queryByLabelText(/collect into/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: /once per data row/i }));
    expect(screen.getByLabelText(/collect into/i)).toBeInTheDocument();
  });

  it("saves the collection beside the fields it gathers", async () => {
    render(
      <NodeConfigPanel
        node={node({ forEachRow: true, outputVars: [{ name: "campaignId", path: "$.data.campaignId" }] })}
        onClose={vi.fn()}
      />,
    );

    await userEvent.type(screen.getByLabelText(/collect into/i), "launched");
    await userEvent.click(screen.getByRole("button", { name: /save configuration/i }));

    const [, config] = updateNodeConfig.mock.calls[0];
    expect(config.collect).toEqual({ into: "launched" });
  });

  it("saves the collect condition, and leaves it out when blank", async () => {
    const { unmount } = render(
      <NodeConfigPanel
        node={node({
          forEachRow: true,
          collect: { into: "launched" },
          outputVars: [{ name: "campaignId", path: "$.campaignId" }],
        })}
        onClose={vi.fn()}
      />,
    );
    await userEvent.type(screen.getByLabelText(/collect only when/i), "response.status == 202");
    await userEvent.click(screen.getByRole("button", { name: /save configuration/i }));
    expect(updateNodeConfig.mock.calls[0][1].collect).toEqual({
      into: "launched",
      when: "response.status == 202",
    });
    unmount();
    updateNodeConfig.mockReset();

    // Blank means absent, not an empty string — a dormant condition would read as one in force.
    render(
      <NodeConfigPanel
        node={node({
          forEachRow: true,
          collect: { into: "launched" },
          outputVars: [{ name: "campaignId", path: "$.campaignId" }],
        })}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /save configuration/i }));
    expect(updateNodeConfig.mock.calls[0][1].collect).toEqual({ into: "launched" });
  });

  it("says what will be carried forward, naming every field", async () => {
    render(
      <NodeConfigPanel
        node={node({
          forEachRow: true,
          collect: { into: "launched" },
          outputVars: [
            { name: "campaignId", path: "$.data.campaignId" },
            { name: "txnId", path: "$.data.txnId" },
          ],
        })}
        onClose={vi.fn()}
      />,
    );
    // Both in one record — the whole reason this is a record and not two parallel arrays.
    expect(screen.getByText(/one record to "launched".*campaignId, txnId/i)).toBeInTheDocument();
  });

  it("offers the field-adding action where the eye already is", async () => {
    // The complaint: "collect into campaign_data" was set, two messages said to add a field,
    // and neither pointed anywhere. `+ Add` is at the top right of the section, above a
    // data-row list long enough to have been scrolled past.
    render(
      <NodeConfigPanel
        node={node({ forEachRow: true, collect: { into: "campaign_data" } })}
        onClose={vi.fn()}
      />,
    );

    // One instruction, not two saying the same thing in different words.
    expect(screen.queryByText(/nothing is carried forward from this response/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Add a field below/i)).toBeInTheDocument();

    // And the action itself, with the shape of what to type.
    const action = screen.getByRole("button", { name: /take a value from every response/i });
    expect(action).toBeInTheDocument();
    await userEvent.click(action);
    expect(screen.getByPlaceholderText("$.campaignId")).toBeInTheDocument();
  });

  it("says fields have nowhere to go when the collection is unnamed", async () => {
    // The failure this replaces: captures that resolve to nothing, whose only symptom was
    // {{name}} arriving literally at a later step.
    render(
      <NodeConfigPanel
        node={node({ forEachRow: true, outputVars: [{ name: "campaignId", path: "$.x" }] })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/need a list to be collected into/i)).toBeInTheDocument();
  });

  it("does not leave a collection behind when the step goes back to running once", async () => {
    // A dormant block reads, to the engine and to the next author, as one that is in use.
    render(
      <NodeConfigPanel
        node={node({ forEachRow: true, collect: { into: "launched" } })}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("radio", { name: /once, as authored/i }));
    await userEvent.click(screen.getByRole("button", { name: /save configuration/i }));

    const [, config] = updateNodeConfig.mock.calls[0];
    expect(config.collect).toBeUndefined();
    expect(config.forEachRow).toBeUndefined();
  });
});

describe("walking a list an earlier step collected", () => {
  beforeEach(() => {
    updateNodeConfig.mockReset();
    datasetRows = rows;
  });

  it("reveals the list to walk, and saves it", async () => {
    render(<NodeConfigPanel node={node()} onClose={vi.fn()} />);
    expect(screen.queryByLabelText(/the list to walk/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: /once per item in a list/i }));
    await userEvent.type(screen.getByLabelText(/the list to walk/i), "{{{{launched}}");
    await userEvent.click(screen.getByRole("button", { name: /save configuration/i }));

    const [, config] = updateNodeConfig.mock.calls[0];
    // Braces stripped, so the panel and the engine read one config the same way.
    expect(config.forEach).toEqual({ list: "launched", as: undefined });
  });

  it("offers the collections earlier steps in this flow produce", async () => {
    render(<NodeConfigPanel node={node({ forEach: { list: "launched" } })} onClose={vi.fn()} />);
    expect(screen.getByText(/collected by an earlier step in this flow: launched/i)).toBeInTheDocument();
  });

  it("doubts a list nothing upstream collects, without refusing it", async () => {
    // A script or a project variable can hold a list too, so this is a doubt — but a typo is
    // far likelier, and saying nothing is how it reaches a run.
    render(<NodeConfigPanel node={node({ forEach: { list: "lanched" } })} onClose={vi.fn()} />);
    expect(screen.getByText(/no earlier step in this flow collects that name/i)).toBeInTheDocument();
  });

  it("cannot express both kinds of fan-out at once", async () => {
    // Three exclusive choices in one control, so the thing the engine refuses is not
    // sayable here in the first place.
    render(<NodeConfigPanel node={node({ forEachRow: true })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("radio", { name: /once per item in a list/i }));
    await userEvent.type(screen.getByLabelText(/the list to walk/i), "launched");
    await userEvent.click(screen.getByRole("button", { name: /save configuration/i }));

    const [, config] = updateNodeConfig.mock.calls[0];
    expect(config.forEach).toEqual({ list: "launched", as: undefined });
    expect(config.forEachRow).toBeUndefined();
  });

  it("takes the suggested item name with one keystroke", async () => {
    // "As of now, I have to type that entire thing."
    render(<NodeConfigPanel node={node({ forEach: { list: "campaignIds" } })} onClose={vi.fn()} />);
    const field = screen.getByLabelText(/name each item/i);
    await userEvent.click(field);
    await userEvent.keyboard("{Tab}");
    expect(field).toHaveValue("campaignId");
  });
});

describe("a whole-response output path", () => {
  it("warns beside the row, where nothing downstream ever will", () => {
    // `$` is the one wrong path with no run-time warning — it always matches, so the engine's
    // "nothing at $.foo" never fires. If the panel does not say it, nothing does.
    render(
      <NodeConfigPanel
        node={node({ outputVars: [{ name: "campaign_info", path: "$" }] })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/entire body/i)).toBeInTheDocument();
    expect(screen.getByText(/always succeeds/i)).toBeInTheDocument();
  });

  it("says nothing for an ordinary path", () => {
    render(
      <NodeConfigPanel
        node={node({ outputVars: [{ name: "campaignId", path: "$.campaignId" }] })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText(/entire body/i)).not.toBeInTheDocument();
  });

  it("appears as soon as $ is typed, not on save", async () => {
    render(
      <NodeConfigPanel
        node={node({ outputVars: [{ name: "campaign_info", path: "" }] })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText(/entire body/i)).not.toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("$.campaignId"), "$");
    expect(screen.getByText(/entire body/i)).toBeInTheDocument();
  });

  it("warns about the record shape when the step runs per row", async () => {
    render(
      <NodeConfigPanel
        node={node({
          forEachRow: true,
          collect: { into: "launched" },
          outputVars: [{ name: "campaign_info", path: "$" }],
        })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/one field containing everything/i)).toBeInTheDocument();
  });
});

describe("adding an output variable", () => {
  /** The Output variables section alone — Input variables has its own Add. */
  const outputSection = () =>
    screen.getByRole("heading", { name: "Output variables" }).closest("section") as HTMLElement;

  const addersIn = (root: HTMLElement) =>
    Array.from(root.querySelectorAll("button")).filter((b) =>
      /take a value|^\s*add\s*$/i.test(b.textContent || ""),
    );

  it("offers exactly one way to add the first one", () => {
    // Both buttons called the same function, and the dashed one sits *inside* this section — so an
    // author asked which of the two fills the collection. "Either" is the answer to a question the
    // panel should not have raised.
    render(<NodeConfigPanel node={node({})} onClose={vi.fn()} />);
    const adders = addersIn(outputSection());
    expect(adders).toHaveLength(1);
    expect(adders[0].textContent).toMatch(/take a value/i);
  });

  it("moves the button to the header once a field exists", () => {
    // The dashed row is a call to action for an empty list; with rows below it, the header is where
    // the eye already is.
    render(
      <NodeConfigPanel
        node={node({ outputVars: [{ name: "campaignId", path: "$.campaignId" }] })}
        onClose={vi.fn()}
      />,
    );
    const adders = addersIn(outputSection());
    expect(adders).toHaveLength(1);
    expect(adders[0].textContent).toMatch(/^\s*Add\s*$/);
  });

  it("the one button adds a row", async () => {
    render(<NodeConfigPanel node={node({})} onClose={vi.fn()} />);
    await userEvent.click(screen.getByText(/take a value/i));
    expect(screen.getByPlaceholderText("$.campaignId")).toBeInTheDocument();
  });
});
