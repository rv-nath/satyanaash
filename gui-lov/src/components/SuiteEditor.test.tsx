/**
 * The suite member picker.
 *
 * Its first test file, added with the section toggles — a project here has 14 flows and 35 tests,
 * so "tick them all" was 49 clicks and the only bulk control was an all-or-nothing one at the
 * project level.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SuiteEditor from "@/components/SuiteEditor";
import type { Suite, SuiteMember } from "@/lib/api/types";

const update = vi.fn();
let suite: Suite;

vi.mock("@/lib/api", () => ({
  suitesApi: {
    get: () => Promise.resolve(suite),
    update: (_id: string, patch: unknown) => {
      update(patch);
      return Promise.resolve({ ...suite, ...(patch as object) });
    },
  },
  flowsApi: {
    list: () =>
      Promise.resolve([
        { id: "f1", name: "auth-boundary" },
        { id: "f2", name: "token-lifecycle" },
      ]),
  },
  testCasesApi: {
    list: () =>
      Promise.resolve([
        { id: "t1", name: "Introspect a token", method: "POST" },
        { id: "t2", name: "Revoke the session", method: "POST" },
        { id: "t3", name: "Refresh the session", method: "POST" },
      ]),
  },
}));

vi.mock("@/contexts/TestProjectContext", () => ({
  useTestProject: () => ({
    executeSuite: vi.fn(),
    isExecuting: false,
    cancelExecution: vi.fn(),
    showConsole: true,
    setShowConsole: vi.fn(),
  }),
}));

const show = async (members: SuiteMember[] | null | undefined) => {
  suite = { id: "s1", project_id: "p1", name: "Smoking Gun Test", members } as Suite;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SuiteEditor suiteId="s1" projectId="p1" />
    </QueryClientProvider>,
  );
  // The rows arrive with the queries.
  await waitFor(() => expect(screen.getByLabelText("auth-boundary")).toBeInTheDocument());
};

const flowsToggle = () => screen.getByLabelText(/all Flows$/i);
const testsToggle = () => screen.getByLabelText(/all Tests on their own$/i);

beforeEach(() => update.mockClear());

describe("the section toggles", () => {
  it("offers one per section, so 49 members are not 49 clicks", async () => {
    await show([]);
    expect(flowsToggle()).toBeInTheDocument();
    expect(testsToggle()).toBeInTheDocument();
  });

  it("ticks every flow and leaves the tests alone", async () => {
    await show([{ kind: "test", id: "t1" }]);
    await userEvent.click(flowsToggle());
    expect(update).toHaveBeenCalledWith({
      members: [
        { kind: "flow", id: "f1" },
        { kind: "flow", id: "f2" },
        { kind: "test", id: "t1" },
      ],
    });
  });

  it("clears a section that is fully ticked", async () => {
    await show([
      { kind: "flow", id: "f1" },
      { kind: "flow", id: "f2" },
      { kind: "test", id: "t1" },
    ]);
    await userEvent.click(flowsToggle());
    expect(update).toHaveBeenCalledWith({ members: [{ kind: "test", id: "t1" }] });
  });

  it("fills the rest when only some are ticked, rather than clearing them", async () => {
    // Clicking a half-filled box to finish filling it is the reading everyone has; clearing is
    // the one nobody expects.
    await show([{ kind: "flow", id: "f1" }]);
    expect(flowsToggle()).toHaveAttribute("data-state", "indeterminate");
    await userEvent.click(flowsToggle());
    expect(update).toHaveBeenCalledWith({
      members: [
        { kind: "flow", id: "f1" },
        { kind: "flow", id: "f2" },
      ],
    });
  });

  it("shows the fraction only while partly selected", async () => {
    // A permanent "35/35" spends attention saying "normal".
    await show([{ kind: "flow", id: "f1" }]);
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("is switched off while Everything is on, exactly as the rows are", async () => {
    // That setting is not a selection this can add to — it is the absence of one.
    await show(null);
    expect(flowsToggle()).toBeDisabled();
    expect(testsToggle()).toBeDisabled();
    expect(flowsToggle()).toHaveAttribute("data-state", "checked");
  });

  it("says in its label which way a click will go", async () => {
    await show([]);
    expect(screen.getByLabelText("Select all Flows")).toBeInTheDocument();
    await show([
      { kind: "flow", id: "f1" },
      { kind: "flow", id: "f2" },
    ]);
    expect(screen.getByLabelText("Clear all Flows")).toBeInTheDocument();
  });
});
