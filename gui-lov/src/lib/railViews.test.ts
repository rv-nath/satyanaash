import { describe, it, expect } from "vitest";
import {
  DEFAULT_RAIL_VIEW,
  RAIL_VIEWS,
  isRailView,
  railViewFrom,
  railViewLabel,
} from "@/lib/railViews";

describe("the rail's views", () => {
  it("starts on the stacked Workspace view", () => {
    // What the sidebar has always shown. A dedicated view hides the others, so the view
    // that hides nothing is the one to land on.
    expect(DEFAULT_RAIL_VIEW).toBe("workspace");
    expect(RAIL_VIEWS[0].id).toBe("workspace");
  });

  it("does not include settings", () => {
    // The distinction the whole design rests on: settings opens a tab, because
    // SettingsPanel already carries its own section nav. A rail entry that switched the
    // sidebar to "settings" would land on a view with nothing in it.
    expect(isRailView("settings")).toBe(false);
    expect(RAIL_VIEWS.map((v) => v.id)).not.toContain("settings");
  });

  it("gives every view a label and a hint", () => {
    for (const view of RAIL_VIEWS) {
      expect(railViewLabel(view.id)).toBe(view.label);
      expect(view.hint.length).toBeGreaterThan(0);
    }
  });

  it("falls back rather than trusting a stored value", () => {
    // A view removed in a later version, or a hand-edited key, would otherwise leave the
    // sidebar blank with no way out except clearing storage.
    expect(railViewFrom("runs")).toBe("runs");
    expect(railViewFrom("nonesuch")).toBe(DEFAULT_RAIL_VIEW);
    expect(railViewFrom(null)).toBe(DEFAULT_RAIL_VIEW);
    expect(railViewFrom("")).toBe(DEFAULT_RAIL_VIEW);
  });
});
