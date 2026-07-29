import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ConsolePanel from "@/components/ConsolePanel";
import type { ConsoleLog } from "@/hooks/useExecutionStream";

const log = (message: string): ConsoleLog => ({
  timestamp: "2026-07-27T09:15:00Z",
  message,
  type: "info",
});

const tabs = [
  { id: "f1", name: "Signup journey", entries: 3, running: false },
  { id: "f2", name: "Campaign", entries: 7, running: true },
];

describe("ConsolePanel", () => {
  it("names each flow's console and marks the one running", () => {
    render(
      <ConsolePanel logs={[log("hello")]} tabs={tabs} activeTabId="f1"
        onSelectTab={vi.fn()} onCloseTab={vi.fn()} />
    );
    expect(screen.getByText("Signup journey")).toBeInTheDocument();
    expect(screen.getByText("Campaign")).toBeInTheDocument();
    // Entry counts sit on the tab, so you can see which run is longer.
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("switches flow on click", async () => {
    const onSelectTab = vi.fn();
    render(
      <ConsolePanel logs={[log("hello")]} tabs={tabs} activeTabId="f1"
        onSelectTab={onSelectTab} onCloseTab={vi.fn()} />
    );
    await userEvent.click(screen.getByText("Campaign"));
    expect(onSelectTab).toHaveBeenCalledWith("f2");
  });

  it("closing a tab doesn't also select it", async () => {
    const onCloseTab = vi.fn();
    const onSelectTab = vi.fn();
    render(
      <ConsolePanel logs={[log("hello")]} tabs={tabs} activeTabId="f1"
        onSelectTab={onSelectTab} onCloseTab={onCloseTab} />
    );
    await userEvent.click(screen.getByRole("button", { name: /close campaign console/i }));
    expect(onCloseTab).toHaveBeenCalledWith("f2");
    expect(onSelectTab).not.toHaveBeenCalled();
  });

  it("says what an empty console is waiting for", () => {
    render(
      <ConsolePanel logs={[]} tabs={[tabs[0]]} activeTabId="f1"
        onSelectTab={vi.fn()} onCloseTab={vi.fn()} />
    );
    expect(screen.getByText(/run this flow and its log appears here/i)).toBeInTheDocument();
  });

  it("copies only the flow on screen", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      <ConsolePanel logs={[log("only mine")]} tabs={tabs} activeTabId="f1"
        onSelectTab={vi.fn()} onCloseTab={vi.fn()} />
    );
    await userEvent.click(screen.getByRole("button", { name: /copy console/i }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("only mine"));
  });
});

describe("ConsolePanel folding", () => {
  const jwt = "e".repeat(2400);
  const withDetails: ConsoleLog[] = [
    {
      timestamp: "2026-07-27T09:15:00Z",
      message: "\u2717 Send SMS: failed (81ms)",
      type: "error",
      details: [
        { label: "Status", value: "400" },
        { label: "Headers", value: `{\n  "Authorization": "Bearer ${jwt}"\n}` },
        { label: "Error", value: "Expected HTTP 401, got 400", type: "error" },
      ],
    },
  ];

  const open = async () => {
    render(
      <ConsolePanel logs={withDetails} tabs={[tabs[0]]} activeTabId="f1"
        onSelectTab={vi.fn()} onCloseTab={vi.fn()} />
    );
    await userEvent.click(screen.getByText(/Send SMS/));
  };

  it("keeps a big detail folded, and short ones in plain sight", async () => {
    await open();
    // The token is not on screen; the label and its size are.
    expect(screen.queryByText(new RegExp(jwt.slice(0, 40)))).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Headers/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(/3 lines \u00b7 2\.\d KB/)).toBeInTheDocument();
    // A status and an error message are the point of opening the entry at all.
    expect(screen.getByText("400")).toBeInTheDocument();
    expect(screen.getByText("Expected HTTP 401, got 400")).toBeInTheDocument();
  });

  it("opens a folded detail on demand", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: /Headers/ }));
    expect(screen.getByRole("button", { name: /Headers/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(new RegExp(jwt.slice(0, 40)))).toBeInTheDocument();
  });

  it("opens and closes every entry from one button", async () => {
    render(
      <ConsolePanel logs={withDetails} tabs={[tabs[0]]} activeTabId="f1"
        onSelectTab={vi.fn()} onCloseTab={vi.fn()} />
    );
    expect(screen.queryByText("400")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /expand all entries/i }));
    expect(screen.getByText("400")).toBeInTheDocument();

    // The same button now offers the opposite, rather than a second dead one.
    await userEvent.click(screen.getByRole("button", { name: /collapse all entries/i }));
    expect(screen.queryByText("400")).not.toBeInTheDocument();
  });

  it("has nothing to expand when no entry carries details", () => {
    render(
      <ConsolePanel logs={[log("plain")]} tabs={[tabs[0]]} activeTabId="f1"
        onSelectTab={vi.fn()} onCloseTab={vi.fn()} />
    );
    expect(screen.getByRole("button", { name: /expand all entries/i })).toBeDisabled();
  });

  it("still copies a folded value in full", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await open();
    await userEvent.click(screen.getByRole("button", { name: /copy console/i }));
    // Folding is about reading, not about what you keep.
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining(jwt));
  });
});
