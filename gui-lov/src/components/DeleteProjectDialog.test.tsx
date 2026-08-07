import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project } from "@/lib/api/types";

const listTestCases = vi.fn();
const listFlows = vi.fn();
const listSuites = vi.fn();
const listRuns = vi.fn();
vi.mock("@/lib/api", () => ({
  testCasesApi: { list: (...a: unknown[]) => listTestCases(...a) },
  flowsApi: { list: (...a: unknown[]) => listFlows(...a) },
  suitesApi: { list: (...a: unknown[]) => listSuites(...a) },
  runsApi: { list: (...a: unknown[]) => listRuns(...a) },
}));

import { DeleteProjectDialog } from "@/components/DeleteProjectDialog";

const project: Project = {
  id: "p1",
  name: "ng-acc",
  description: null,
  settings: {},
  created_at: "2026-04-06T06:41:59Z",
  updated_at: "2026-07-27T00:00:00Z",
};

const renderDialog = () => {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DeleteProjectDialog project={project} onClose={onClose} onConfirm={onConfirm} />
    </QueryClientProvider>,
  );
  return { onConfirm, onClose };
};

const deleteButton = () => screen.getByRole("button", { name: /delete this project/i });

beforeEach(() => {
  for (const m of [listTestCases, listFlows, listSuites, listRuns]) m.mockReset();
  listTestCases.mockResolvedValue(new Array(18).fill({}));
  listFlows.mockResolvedValue(new Array(6).fill({}));
  listSuites.mockResolvedValue(new Array(1).fill({}));
  listRuns.mockResolvedValue({ runs: new Array(12).fill({}), adhoc_hidden: 0 });
});

describe("deleting a project", () => {
  it("will not delete until the name is typed", async () => {
    // The guard the whole dialog exists for. This used to be one click in a dropdown menu.
    const { onConfirm } = renderDialog();
    expect(deleteButton()).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/type .* to confirm/i), "ng-ac");
    expect(deleteButton()).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/type .* to confirm/i), "c");
    expect(deleteButton()).toBeEnabled();

    await userEvent.click(deleteButton());
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("says what will be lost, because a confirmation with no stakes is a rubber stamp", async () => {
    renderDialog();
    expect(
      await screen.findByText(/18 requests, 6 flows, 1 suite and 12 runs/),
    ).toBeInTheDocument();
    expect(screen.getByText(/no undo and no export/i)).toBeInTheDocument();
  });

  it("counts ad-hoc runs too — history is the part that cannot be rebuilt", async () => {
    renderDialog();
    await screen.findByText(/18 requests/);
    expect(listRuns).toHaveBeenCalledWith("p1", { includeAdhoc: true });
  });

  it("does not claim a project is empty when it could not look", async () => {
    // Refusing to delete would strand someone whose server is down, but the dialog must not
    // imply there is nothing to lose.
    listFlows.mockRejectedValue(new Error("network"));
    renderDialog();
    expect(await screen.findByText(/could not check what is in this project/i)).toBeInTheDocument();
    expect(screen.queryByText(/this project is empty/i)).not.toBeInTheDocument();
  });

  it("says a project is empty only when it really looked and found nothing", async () => {
    listTestCases.mockResolvedValue([]);
    listFlows.mockResolvedValue([]);
    listSuites.mockResolvedValue([]);
    listRuns.mockResolvedValue({ runs: [], adhoc_hidden: 0 });
    renderDialog();
    expect(await screen.findByText(/this project is empty/i)).toBeInTheDocument();
  });

  it("ignores Enter until the name matches", async () => {
    // Otherwise the same keystroke that opened the menu could confirm the deletion.
    const { onConfirm } = renderDialog();
    const field = screen.getByLabelText(/type .* to confirm/i);
    await userEvent.type(field, "ng{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();

    await userEvent.clear(field);
    await userEvent.type(field, "ng-acc{Enter}");
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
