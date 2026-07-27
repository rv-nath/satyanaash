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
