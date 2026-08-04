import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActivityRail } from "@/components/ActivityRail";
import { RAIL_VIEWS } from "@/lib/railViews";

const renderRail = (over: Partial<Parameters<typeof ActivityRail>[0]> = {}) => {
  const onSelect = vi.fn();
  const onOpenSettings = vi.fn();
  render(
    <ActivityRail view="workspace" onSelect={onSelect} onOpenSettings={onOpenSettings} {...over} />,
  );
  return { onSelect, onOpenSettings };
};

describe("the activity rail", () => {
  it("offers every sidebar view, plus settings", () => {
    renderRail();
    for (const view of RAIL_VIEWS) {
      expect(screen.getByRole("button", { name: new RegExp(view.label, "i") })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: /settings/i })).toBeInTheDocument();
  });

  it("switches the sidebar when a view is picked", async () => {
    const { onSelect } = renderRail();
    await userEvent.click(screen.getByRole("button", { name: /suites/i }));
    expect(onSelect).toHaveBeenCalledWith("suites");
  });

  it("opens settings as a tab rather than as a sidebar view", async () => {
    // The load-bearing distinction. Route settings through onSelect and the rail would
    // switch the sidebar to a view that has nothing in it, stranding you there.
    const { onSelect, onOpenSettings } = renderRail();
    await userEvent.click(screen.getByRole("button", { name: /settings/i }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("marks where you are, not what is pressed", async () => {
    // aria-current, not aria-pressed: these are navigation. One is always the one you are
    // on, and clicking it again does nothing.
    renderRail({ view: "runs" });
    expect(screen.getByRole("button", { name: /runs/i })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /workspace/i })).not.toHaveAttribute("aria-current");
  });

  it("marks the gear while the settings tab is the active surface", () => {
    // Otherwise the rail claims you are on a sidebar view when the workspace is showing
    // settings — two answers to "where am I".
    renderRail({ settingsActive: true });
    expect(screen.getByRole("button", { name: /settings/i })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });
});
