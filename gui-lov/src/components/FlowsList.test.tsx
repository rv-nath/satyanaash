import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The flows rail, once flows can live in buckets.
 *
 * The arrangement itself is pinned in `lib/flowGrouping.test.ts`; this covers the parts only a
 * render can show — that the headings are drop targets, that a failed move puts the row back,
 * and that Ungrouped offers no rename or delete because it has no row in the database.
 */

const setFlowGroup = vi.fn();
let flows: {
  id: string;
  name: string;
  groupId?: string | null;
  testCases: unknown[];
  internalNodes?: { data?: Record<string, unknown> }[];
}[] = [];
/** The project's requests, as the tests rail's query already has them. */
let projectRequests: { id: string; name: string; method: string; endpoint: string }[] = [];

vi.mock("@/contexts/TestProjectContext", () => ({
  useTestProject: () => ({ flows, projectId: "p1", setFlowGroup }),
}));

let groups: { id: string; name: string }[] = [];
const moveMutate = vi.fn();
const createMutate = vi.fn();
const renameMutate = vi.fn();
const deleteMutate = vi.fn();

vi.mock("@/hooks/useApi", () => ({
  useTestCases: () => ({ data: projectRequests }),
  useFlowGroups: () => ({ data: groups }),
  useCreateFlowGroup: () => ({ mutate: createMutate }),
  useRenameFlowGroup: () => ({ mutate: renameMutate }),
  useDeleteFlowGroup: () => ({ mutate: deleteMutate }),
  useMoveFlowToGroup: () => ({ mutate: moveMutate }),
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (m: string) => toastError(m) } }));

import { FlowsList } from "@/components/FlowsList";

const flow = (
  id: string,
  name: string,
  groupId?: string | null,
  runs: string[] = [],
) => ({
  id,
  name,
  groupId,
  testCases: [],
  internalNodes: [
    { data: {} },
    ...runs.map((testCaseId) => ({ data: { testCaseId } })),
    { data: {} },
  ],
});

const renderRail = () =>
  render(
    <FlowsList
      onOpenFlow={vi.fn()}
      onAddGroup={vi.fn()}
      onEditGroup={vi.fn()}
      onCloneGroup={vi.fn()}
      onDeleteGroup={vi.fn()}
    />,
  );

/** A drag of one flow onto a heading, the way the component reads it. */
const dropOn = async (heading: HTMLElement, flowId: string) => {
  const payload = JSON.stringify({ type: "flow", flowId });
  const dataTransfer = { getData: () => payload, setData: vi.fn() };
  await userEvent.pointer({ target: heading });
  const { fireEvent } = await import("@testing-library/react");
  fireEvent.dragOver(heading, { dataTransfer });
  fireEvent.drop(heading, { dataTransfer });
};

const heading = (name: string) =>
  screen.getByText(name, { selector: "span" }).closest("div") as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  // The collapse test writes here, and a collapsed bucket would hide rows from every test that
  // ran after it — an order dependency that passes today and breaks the day one is reordered.
  localStorage.clear();
  groups = [{ id: "g1", name: "Campaigns" }];
  projectRequests = [];
  flows = [flow("f1", "JT1 - SMS", "g1"), flow("f2", "Balance")];
});

describe("the flows rail in buckets", () => {
  it("shows each group with its flows, and Ungrouped for the rest", () => {
    renderRail();
    expect(screen.getByText("Campaigns")).toBeInTheDocument();
    expect(screen.getByText("Ungrouped")).toBeInTheDocument();
    expect(screen.getByText("JT1 - SMS")).toBeInTheDocument();
    expect(screen.getByText("Balance")).toBeInTheDocument();
  });

  it("draws an empty group rather than hiding it", () => {
    // A bucket that vanishes until something is in it gives you nowhere to drop the first flow.
    flows = [flow("f2", "Balance")];
    renderRail();
    expect(screen.getByText("Campaigns")).toBeInTheDocument();
    expect(screen.getByText(/drag a flow here/i)).toBeInTheDocument();
  });

  it("offers no rename or delete on Ungrouped, which has no row to act on", () => {
    renderRail();
    expect(
      screen.getByRole("button", { name: /campaigns group actions/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /ungrouped group actions/i }),
    ).not.toBeInTheDocument();
  });

  it("collapses a group and remembers it per project", async () => {
    renderRail();
    await userEvent.click(screen.getByText("Campaigns"));
    expect(screen.queryByText("JT1 - SMS")).not.toBeInTheDocument();
    expect(localStorage.getItem("sat.flowGroups.collapsed.p1")).toContain("g1");
  });
});

describe("moving a flow between buckets", () => {
  it("moves it locally first, then tells the server", async () => {
    renderRail();
    await dropOn(heading("Campaigns"), "f2");

    // Locally first, so the row lands under the cursor rather than after a round trip.
    expect(setFlowGroup).toHaveBeenCalledWith("f2", "g1");
    expect(moveMutate.mock.calls[0][0]).toMatchObject({ flowId: "f2", groupId: "g1" });
  });

  it("treats a drop on Ungrouped as a real move out of every group", async () => {
    // Unlike the tests rail, where dropping on Ungrouped does nothing at all.
    renderRail();
    await dropOn(heading("Ungrouped"), "f1");
    expect(setFlowGroup).toHaveBeenCalledWith("f1", null);
    expect(moveMutate.mock.calls[0][0]).toMatchObject({ flowId: "f1", groupId: null });
  });

  it("does nothing when the flow is dropped where it already was", async () => {
    renderRail();
    await dropOn(heading("Campaigns"), "f1");
    expect(setFlowGroup).not.toHaveBeenCalled();
    expect(moveMutate).not.toHaveBeenCalled();
  });

  it("puts the row back when the server refuses", async () => {
    // A row that stays where you dropped it while the server disagrees is the worst outcome:
    // you would only find out on the next reload.
    moveMutate.mockImplementation((_vars, opts) => opts?.onError?.(new Error("nope")));
    renderRail();
    await dropOn(heading("Campaigns"), "f2");

    expect(setFlowGroup).toHaveBeenNthCalledWith(1, "f2", "g1");
    expect(setFlowGroup).toHaveBeenNthCalledWith(2, "f2", null);
    expect(toastError).toHaveBeenCalledWith("nope");
  });

  it("ignores something dragged from another rail", async () => {
    // A test-case payload carries no flowId, so this one is inert whatever the guard says.
    renderRail();
    const target = heading("Campaigns");
    const dataTransfer = { getData: () => JSON.stringify({ type: "testCase", testCaseId: "t1" }) };
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.drop(target, { dataTransfer });
    expect(moveMutate).not.toHaveBeenCalled();
  });

  it("checks the payload's type, not just that it names a flow", async () => {
    // What the `type === "flow"` half of the guard is actually for. Today's test-case payload has
    // no flowId, so the test above would pass with the type check deleted — this one would not.
    // A future payload that references a flow (a run, a suite member) would otherwise be read as
    // a request to move it.
    renderRail();
    const target = heading("Campaigns");
    const dataTransfer = {
      getData: () => JSON.stringify({ type: "run", flowId: "f2", runId: "r1" }),
    };
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.drop(target, { dataTransfer });
    expect(moveMutate).not.toHaveBeenCalled();
    expect(setFlowGroup).not.toHaveBeenCalled();
  });

  it("survives a drop carrying no JSON at all", async () => {
    renderRail();
    const target = heading("Campaigns");
    const dataTransfer = { getData: () => "" };
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.drop(target, { dataTransfer });
    expect(moveMutate).not.toHaveBeenCalled();
  });
});

describe("what a dragged flow carries", () => {
  it("carries both shapes, because two drop targets read it differently", async () => {
    // This rail's own headings read the flat `flowId`; the canvas reads `data` and hands it to
    // `addNodeToCanvas`. It carried only the flat key for as long as sub-flow nodes have
    // existed, so dragging a flow onto the canvas threw inside a catch and did nothing at all.
    // Drop either half and one of the two targets goes silent again.
    flows = [flow("f1", "Onboard an enterprise", "g1")];
    renderRail();
    const setData = vi.fn();
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.dragStart(screen.getByText("Onboard an enterprise"), {
      dataTransfer: { setData },
    });

    const [, raw] = setData.mock.calls[0];
    expect(JSON.parse(raw)).toEqual({
      type: "flow",
      flowId: "f1",
      data: { flowId: "f1", label: "Onboard an enterprise" },
    });
  });
});

describe("creating a flow from a group's own menu", () => {
  it("asks for it in that group, not in Ungrouped", async () => {
    // The menu offered rename and delete only, so the way to get a flow into a bucket was to
    // create it and then drag it there.
    const onAddGroup = vi.fn();
    render(
      <FlowsList
        onOpenFlow={vi.fn()}
        onAddGroup={onAddGroup}
        onEditGroup={vi.fn()}
        onCloneGroup={vi.fn()}
        onDeleteGroup={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /campaigns group actions/i }));
    await userEvent.click(screen.getByText(/new flow in this group/i));
    expect(onAddGroup).toHaveBeenCalledWith("g1");
  });

  it("expands the group first, so the new flow is not created out of sight", async () => {
    const onAddGroup = vi.fn();
    render(
      <FlowsList
        onOpenFlow={vi.fn()}
        onAddGroup={onAddGroup}
        onEditGroup={vi.fn()}
        onCloneGroup={vi.fn()}
        onDeleteGroup={vi.fn()}
      />,
    );
    // Collapse it, then create through the menu.
    await userEvent.click(screen.getByRole("button", { name: /campaigns/i, expanded: true }));
    expect(screen.queryByText("JT1 - SMS")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /campaigns group actions/i }));
    await userEvent.click(screen.getByText(/new flow in this group/i));
    expect(screen.getByText("JT1 - SMS")).toBeInTheDocument();
  });

  it("still creates an ungrouped flow from the header button", async () => {
    // And passes no bucket — React would otherwise hand the click event through as one.
    const onAddGroup = vi.fn();
    render(
      <FlowsList
        onOpenFlow={vi.fn()}
        onAddGroup={onAddGroup}
        onEditGroup={vi.fn()}
        onCloneGroup={vi.fn()}
        onDeleteGroup={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /new flow/i }));
    expect(onAddGroup).toHaveBeenCalledWith();
  });

  it("offers nothing of the sort on Ungrouped, which is not a group", async () => {
    render(
      <FlowsList
        onOpenFlow={vi.fn()}
        onAddGroup={vi.fn()}
        onEditGroup={vi.fn()}
        onCloneGroup={vi.fn()}
        onDeleteGroup={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /ungrouped group actions/i }),
    ).not.toBeInTheDocument();
  });
});

describe("creating and renaming a group", () => {
  it("creates one inline", async () => {
    renderRail();
    await userEvent.click(screen.getByRole("button", { name: /new group/i }));
    await userEvent.type(screen.getByLabelText(/new group name/i), "Signup{Enter}");
    expect(createMutate.mock.calls[0][0]).toMatchObject({ projectId: "p1", name: "Signup" });
  });

  it("keeps the server's reason when a name is taken", async () => {
    // "Failed to create group" throws away the only useful part — which name, and that it
    // already exists.
    createMutate.mockImplementation((_v, opts) =>
      opts?.onError?.(new Error('A group called "Signup" already exists in this project')),
    );
    renderRail();
    await userEvent.click(screen.getByRole("button", { name: /new group/i }));
    await userEvent.type(screen.getByLabelText(/new group name/i), "Signup{Enter}");
    expect(toastError).toHaveBeenCalledWith(
      'A group called "Signup" already exists in this project',
    );
  });

  it("abandons a new group on Escape without asking the server", async () => {
    renderRail();
    await userEvent.click(screen.getByRole("button", { name: /new group/i }));
    await userEvent.type(screen.getByLabelText(/new group name/i), "Half typed{Escape}");
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("renames in place", async () => {
    renderRail();
    await userEvent.click(screen.getByRole("button", { name: /campaigns group actions/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /rename group/i }));
    const field = screen.getByLabelText(/rename campaigns/i);
    await userEvent.clear(field);
    await userEvent.type(field, "SMS Campaigns{Enter}");
    expect(renameMutate.mock.calls[0][0]).toMatchObject({ id: "g1", name: "SMS Campaigns" });
  });
});

describe("deleting a group", () => {
  it("says what survives before the click, not after", async () => {
    renderRail();
    await userEvent.click(screen.getByRole("button", { name: /campaigns group actions/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /delete group/i }));
    expect(screen.getByText(/move to Ungrouped — nothing is lost/i)).toBeInTheDocument();
  });

  it("ungroups its flows locally rather than refetching them", async () => {
    // Autosave debounces at 2000ms, so refetching the flows here could return a pre-edit graph
    // and overwrite unsaved canvas work.
    renderRail();
    await userEvent.click(screen.getByRole("button", { name: /campaigns group actions/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /delete group/i }));
    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: /delete/i }),
    );

    expect(deleteMutate.mock.calls[0][0]).toMatchObject({ id: "g1", projectId: "p1" });
    expect(setFlowGroup).toHaveBeenCalledWith("f1", null);
    // The flow that was already Ungrouped is left alone.
    expect(setFlowGroup).not.toHaveBeenCalledWith("f2", null);
  });
});

/**
 * Searching by request.
 *
 * The box says "Search flows and their requests..", and the second half had never worked: every
 * flow reached `filterFlows` with `testCases: []`, because the field is hard-coded empty for any
 * flow loaded from the API. The requests are resolved from each flow's own nodes now, and these
 * tests are the wiring — cut the resolution and they fail while `flowSearch`'s own stay green.
 */
describe("searching flows by the requests inside them", () => {
  beforeEach(() => {
    projectRequests = [
      { id: "tc1", name: "Login-2-Ngage", method: "POST", endpoint: "/api/v1/login" },
      { id: "tc2", name: "SignUp API", method: "POST", endpoint: "/accounts/users/signup" },
    ];
    // "Balance" runs the login request; its own name says nothing about logging in.
    flows = [flow("f1", "JT1 - SMS", "g1", ["tc2"]), flow("f2", "Balance", null, ["tc1"])];
  });

  it("finds a flow by a request it runs, not only by its own name", async () => {
    renderRail();
    await userEvent.type(screen.getByPlaceholderText(/search flows/i), "login");
    expect(screen.getByText("Balance")).toBeInTheDocument();
    expect(screen.queryByText("JT1 - SMS")).not.toBeInTheDocument();
  });

  it("says why a flow whose name does not match is in the list", async () => {
    // Without the annotation, "Balance" appearing under `login` reads as a bug.
    renderRail();
    await userEvent.type(screen.getByPlaceholderText(/search flows/i), "login");
    expect(screen.getByText(/via Login-2-Ngage/)).toBeInTheDocument();
  });

  it("matches on the endpoint too", async () => {
    renderRail();
    await userEvent.type(screen.getByPlaceholderText(/search flows/i), "users/signup");
    expect(screen.getByText("JT1 - SMS")).toBeInTheDocument();
    expect(screen.queryByText("Balance")).not.toBeInTheDocument();
  });

  it("does not annotate a flow that matched on its own name", async () => {
    renderRail();
    await userEvent.type(screen.getByPlaceholderText(/search flows/i), "balance");
    expect(screen.getByText("Balance")).toBeInTheDocument();
    expect(screen.queryByText(/via /)).not.toBeInTheDocument();
  });
});
