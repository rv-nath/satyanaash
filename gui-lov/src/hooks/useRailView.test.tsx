import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRailView } from "@/hooks/useRailView";

beforeEach(() => localStorage.clear());

describe("useRailView", () => {
  it("defaults to the stacked Workspace view", () => {
    const { result } = renderHook(() => useRailView());
    expect(result.current.view).toBe("workspace");
  });

  it("remembers the view across a remount", () => {
    // Reopening a project should land where you left it — the view you want is a property
    // of how you work, not of the project.
    const first = renderHook(() => useRailView());
    act(() => first.result.current.setView("runs"));
    expect(localStorage.getItem("sat.railView")).toBe("runs");

    const second = renderHook(() => useRailView());
    expect(second.result.current.view).toBe("runs");
  });

  it("does not wedge on a value it does not recognise", () => {
    // A blank sidebar with no way out except clearing storage is the failure this avoids.
    localStorage.setItem("sat.railView", "settings");
    expect(renderHook(() => useRailView()).result.current.view).toBe("workspace");

    localStorage.setItem("sat.railView", "{}");
    expect(renderHook(() => useRailView()).result.current.view).toBe("workspace");
  });
});
