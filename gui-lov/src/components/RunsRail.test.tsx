import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SuiteRun } from "@/lib/api/types";

const list = vi.fn();
vi.mock("@/lib/api", () => ({ runsApi: { list: (...args: unknown[]) => list(...args) } }));

import { RunsRail } from "@/components/RunsRail";

const run = (over: Partial<SuiteRun> = {}): SuiteRun => ({
  id: "r1",
  project_id: "p1",
  suite_id: "s1",
  suite_name: "Nightly regression",
  status: "completed",
  started_at: new Date().toISOString(),
  duration_ms: 124_000,
  total: 49,
  passed: 49,
  failed: 0,
  errors: 0,
  skipped: 0,
  ...over,
});

const renderRail = () => {
  const onOpenRun = vi.fn();
  const onOpenFullHistory = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RunsRail projectId="p1" onOpenRun={onOpenRun} onOpenFullHistory={onOpenFullHistory} />
    </QueryClientProvider>,
  );
  return { onOpenRun, onOpenFullHistory };
};

beforeEach(() => {
  list.mockReset();
  list.mockResolvedValue({ runs: [run()], adhoc_hidden: 0 });
});

describe("the runs rail", () => {
  it("opens a run without leaving the canvas", async () => {
    // The reason this list exists: picking a run used to mean switching to a full-screen
    // tab and giving up whatever you were reading.
    const { onOpenRun } = renderRail();
    const row = await screen.findByRole("button", { name: /Nightly regression/ });
    await userEvent.click(row);
    expect(onOpenRun).toHaveBeenCalledWith("r1");
  });

  it("keeps only the facts that fit, and spells none of them out", async () => {
    // The first attempt kept everything `RunHistory` shows and clipped mid-word —
    // "35/49 passed · 14 fa" — which spends the space without finishing the sentence. So
    // the row carries bare numbers beside the name and the time beneath it, and the
    // breakdown lives in the tooltip.
    renderRail();
    expect(await screen.findByText("Nightly regression")).toBeInTheDocument();
    expect(screen.getByText("49/49")).toBeInTheDocument();
    expect(screen.getByText("2m 04s")).toBeInTheDocument();
    // "passed" spelled out on the row is what pushed the name off it.
    expect(screen.queryByText(/49\/49 passed/)).not.toBeInTheDocument();
    // Still reachable, in full, without leaving the sidebar.
    expect(screen.getByRole("button", { name: /Nightly regression/ })).toHaveAttribute(
      "title",
      expect.stringContaining("49/49 passed"),
    );
  });

  it("says when a run was a flow someone ran by hand", async () => {
    list.mockResolvedValue({ runs: [run({ suite_id: null, suite_name: "JT1 – SMS" })], adhoc_hidden: 0 });
    renderRail();
    expect(await screen.findByText(/ad-hoc/)).toBeInTheDocument();
  });

  it("counts what it is not showing rather than omitting it silently", async () => {
    list.mockResolvedValue({ runs: [run()], adhoc_hidden: 12 });
    renderRail();
    expect(await screen.findByText(/12 ad-hoc flow runs hidden/)).toBeInTheDocument();
  });

  it("keeps the wide view one click away", async () => {
    // Comparing across runs needs the columns this list dropped, so the full history is
    // reachable rather than replaced.
    const { onOpenRun, onOpenFullHistory } = renderRail();
    await userEvent.click(screen.getByRole("button", { name: /open full run history/i }));
    expect(onOpenFullHistory).toHaveBeenCalledOnce();
    expect(onOpenRun).not.toHaveBeenCalled();
  });

  it("says so when there is nothing yet", async () => {
    list.mockResolvedValue({ runs: [], adhoc_hidden: 0 });
    renderRail();
    expect(await screen.findByText(/Run a suite and it appears here/)).toBeInTheDocument();
  });
});
