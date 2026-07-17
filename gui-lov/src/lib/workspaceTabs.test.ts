import { describe, it, expect } from "vitest";
import {
  initialWorkspaceState, openTestTab, closeTestTab, setActive, switchFlow,
} from "@/lib/workspaceTabs";

describe("workspaceTabs", () => {
  it("starts on the pinned canvas tab with no open tests", () => {
    const s = initialWorkspaceState();
    expect(s.active).toBe("canvas");
    expect(s.openTestIds).toEqual([]);
  });

  it("opening a test adds it and activates it", () => {
    const s = openTestTab(initialWorkspaceState(), "t1");
    expect(s.openTestIds).toEqual(["t1"]);
    expect(s.active).toBe("t1");
  });

  it("opening an already-open test does not duplicate, just activates", () => {
    let s = openTestTab(initialWorkspaceState(), "t1");
    s = openTestTab(s, "t2");
    s = openTestTab(s, "t1");
    expect(s.openTestIds).toEqual(["t1", "t2"]);
    expect(s.active).toBe("t1");
  });

  it("closing the active test activates its right neighbor, else left, else canvas", () => {
    let s = initialWorkspaceState();
    s = openTestTab(s, "t1");
    s = openTestTab(s, "t2");
    s = openTestTab(s, "t3");
    s = setActive(s, "t2");
    s = closeTestTab(s, "t2");
    expect(s.openTestIds).toEqual(["t1", "t3"]);
    expect(s.active).toBe("t3"); // right neighbor
    s = closeTestTab(s, "t3");
    expect(s.active).toBe("t1"); // left neighbor when no right
    s = closeTestTab(s, "t1");
    expect(s.active).toBe("canvas"); // nothing left
  });

  it("closing a non-active test keeps the active tab", () => {
    let s = openTestTab(initialWorkspaceState(), "t1");
    s = openTestTab(s, "t2");
    s = setActive(s, "t2");
    s = closeTestTab(s, "t1");
    expect(s.openTestIds).toEqual(["t2"]);
    expect(s.active).toBe("t2");
  });

  it("switching flow keeps open test tabs but returns to canvas", () => {
    let s = openTestTab(initialWorkspaceState(), "t1");
    s = openTestTab(s, "t2");
    s = switchFlow(s);
    expect(s.openTestIds).toEqual(["t1", "t2"]);
    expect(s.active).toBe("canvas");
  });
});
