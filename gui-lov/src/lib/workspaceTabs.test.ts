import { describe, it, expect } from "vitest";
import {
  MAX_TABS, tabKey, initialWorkspaceState, openTest, openFlow, openSettings, openSuite,
  openRuns, openRun, togglePinned, closeTab, setActive, tabCount, atCap, isSingleton,
  nothingOpen, activeSurface,
} from "@/lib/workspaceTabs";

describe("workspaceTabs", () => {
  it("starts empty (no active tab)", () => {
    const s = initialWorkspaceState();
    expect(s.tabs).toEqual([]);
    expect(s.settingsOpen).toBe(false);
    expect(s.active).toBeNull();
  });

  it("opens a test tab and activates it", () => {
    const { state } = openTest(initialWorkspaceState(), "t1");
    expect(state.tabs).toEqual([{ kind: "test", id: "t1" }]);
    expect(state.active).toBe(tabKey("test", "t1"));
  });

  it("opening an already-open test just activates it (no dup)", () => {
    let s = openTest(initialWorkspaceState(), "t1").state;
    s = openTest(s, "t2").state;
    s = openTest(s, "t1").state;
    expect(s.tabs.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(s.active).toBe(tabKey("test", "t1"));
  });

  it("opens a flow tab", () => {
    const { state } = openFlow(initialWorkspaceState(), "f1");
    expect(state.tabs).toEqual([{ kind: "flow", id: "f1" }]);
    expect(state.active).toBe(tabKey("flow", "f1"));
  });

  it("reuses the active flow tab when it is unedited (canReuseActive)", () => {
    const { state: s1 } = openFlow(initialWorkspaceState(), "f1");
    const { state: s2 } = openFlow(s1, "f2", { canReuseActive: true });
    expect(s2.tabs).toEqual([{ kind: "flow", id: "f2" }]); // f1 replaced
    expect(s2.active).toBe(tabKey("flow", "f2"));
  });

  it("opens a new flow tab when the active flow is edited (no reuse)", () => {
    const { state: s1 } = openFlow(initialWorkspaceState(), "f1");
    const { state: s2 } = openFlow(s1, "f2", { canReuseActive: false });
    expect(s2.tabs.map((t) => t.id)).toEqual(["f1", "f2"]);
    expect(s2.active).toBe(tabKey("flow", "f2"));
  });

  it("does not reuse when the active tab is a test (canReuseActive ignored)", () => {
    let s = openTest(initialWorkspaceState(), "t1").state;
    const { state } = openFlow(s, "f1", { canReuseActive: true });
    expect(state.tabs.map((t) => `${t.kind}:${t.id}`)).toEqual(["test:t1", "flow:f1"]);
  });

  it("opens settings as a singleton and activates it", () => {
    const s = openSettings(initialWorkspaceState());
    expect(s.settingsOpen).toBe(true);
    expect(s.active).toBe("settings");
    // opening again is idempotent
    const s2 = openSettings(s);
    expect(s2.settingsOpen).toBe(true);
  });

  it("caps flow/test tabs at MAX_TABS and signals when capped", () => {
    let s = initialWorkspaceState();
    for (let i = 0; i < MAX_TABS; i++) s = openTest(s, `t${i}`).state;
    expect(tabCount(s)).toBe(MAX_TABS);
    expect(atCap(s)).toBe(true);
    const r = openTest(s, "overflow");
    expect(r.capped).toBe(true);
    expect(r.state.tabs.length).toBe(MAX_TABS); // unchanged
  });

  it("settings does not count toward the cap", () => {
    let s = initialWorkspaceState();
    for (let i = 0; i < MAX_TABS; i++) s = openTest(s, `t${i}`).state;
    const withSettings = openSettings(s);
    expect(withSettings.settingsOpen).toBe(true);
    expect(tabCount(withSettings)).toBe(MAX_TABS);
  });

  it("closing the active tab picks the right neighbor, then left, then null", () => {
    let s = initialWorkspaceState();
    s = openTest(s, "t1").state;
    s = openTest(s, "t2").state;
    s = openTest(s, "t3").state;
    s = setActive(s, tabKey("test", "t2"));
    s = closeTab(s, tabKey("test", "t2"));
    expect(s.active).toBe(tabKey("test", "t3")); // right neighbor
    s = closeTab(s, tabKey("test", "t3"));
    expect(s.active).toBe(tabKey("test", "t1")); // left neighbor
    s = closeTab(s, tabKey("test", "t1"));
    expect(s.active).toBeNull(); // empty
  });

  it("closing settings falls back to the last tab, or null", () => {
    let s = openTest(initialWorkspaceState(), "t1").state;
    s = openSettings(s);
    s = closeTab(s, "settings");
    expect(s.settingsOpen).toBe(false);
    expect(s.active).toBe(tabKey("test", "t1"));

    let empty = openSettings(initialWorkspaceState());
    empty = closeTab(empty, "settings");
    expect(empty.active).toBeNull();
  });
});

describe("suite tabs", () => {
  it("opens like a test tab — one per suite, no preview reuse", () => {
    // Flow tabs reuse the active tab when unedited; a suite is a thing you edit and run,
    // so it gets its own tab and keeps it.
    let s = openSuite(initialWorkspaceState(), "s1").state;
    expect(s.tabs).toEqual([{ kind: "suite", id: "s1" }]);
    expect(s.active).toBe(tabKey("suite", "s1"));

    s = openSuite(s, "s1").state;
    expect(s.tabs).toHaveLength(1);
  });

  it("counts against the tab cap like any other", () => {
    let s = initialWorkspaceState();
    for (let i = 0; i < MAX_TABS; i++) s = openFlow(s, `f${i}`).state;
    expect(atCap(s)).toBe(true);

    const { state, capped } = openSuite(s, "s1");
    expect(capped).toBe(true);
    expect(tabCount(state)).toBe(MAX_TABS);
  });

  it("closes and hands focus to its neighbour", () => {
    let s = openSuite(initialWorkspaceState(), "s1").state;
    s = openSuite(s, "s2").state;
    s = setActive(s, tabKey("suite", "s1"));
    s = closeTab(s, tabKey("suite", "s1"));
    expect(s.active).toBe(tabKey("suite", "s2"));
  });
});

describe("activeSurface", () => {
  it("gives exactly one answer for every kind of tab", () => {
    const s = initialWorkspaceState();
    expect(activeSurface(openFlow(s, "f1").state)).toEqual({ kind: "flow", id: "f1" });
    expect(activeSurface(openTest(s, "t1").state)).toEqual({ kind: "test", id: "t1" });
    expect(activeSurface(openSuite(s, "s1").state)).toEqual({ kind: "suite", id: "s1" });
    expect(activeSurface(openRun(s, "r1").state)).toEqual({ kind: "run", id: "r1" });
    expect(activeSurface(openSettings(s))).toEqual({ kind: "settings" });
    expect(activeSurface(openRuns(s))).toEqual({ kind: "runs" });
    expect(activeSurface(s)).toEqual({ kind: "empty" });
  });

  it("does not mistake the runs index for a run tab", () => {
    // "runs" and "run:<id>" differ by one character at the front. Getting this wrong
    // would send the history index to the run view with an id of "s".
    expect(activeSurface(openRuns(initialWorkspaceState())).kind).toBe("runs");
    expect(activeSurface(openRun(initialWorkspaceState(), "s").state)).toEqual({
      kind: "run",
      id: "s",
    });
  });

  it("keeps an id containing a colon whole", () => {
    // Ids are opaque. Splitting on every colon rather than the first would truncate one.
    expect(activeSurface(openRun(initialWorkspaceState(), "a:b:c").state)).toEqual({
      kind: "run",
      id: "a:b:c",
    });
  });

  it("falls back to empty for an active nobody recognises", () => {
    // A blank pane with no way out would be worse than the welcome screen.
    const s = setActive(initialWorkspaceState(), "nonsense");
    expect(activeSurface(s)).toEqual({ kind: "empty" });
  });

  it("follows the active tab rather than what happens to be open", () => {
    // Several tabs are open at once and some stay mounted while hidden. Only one is the
    // surface, and it is whichever is active.
    let s = openFlow(initialWorkspaceState(), "f1").state;
    s = openRun(s, "r1").state;
    expect(activeSurface(s)).toEqual({ kind: "run", id: "r1" });
    s = setActive(s, tabKey("flow", "f1"));
    expect(activeSurface(s)).toEqual({ kind: "flow", id: "f1" });
  });
});

describe("nothingOpen", () => {
  it("is true only when nothing is open", () => {
    expect(nothingOpen(initialWorkspaceState())).toBe(true);
  });

  it("is false for every kind of tab, including ones added later", () => {
    // The bug this replaces: the page decided to show its welcome screen from a list of
    // negations — "not a test, not settings, not a suite…" — and the first kind missed
    // rendered the welcome screen *on top of* that tab. Derived from `active`, a new
    // kind cannot be forgotten.
    const s = initialWorkspaceState();
    expect(nothingOpen(openFlow(s, "f1").state)).toBe(false);
    expect(nothingOpen(openTest(s, "t1").state)).toBe(false);
    expect(nothingOpen(openSuite(s, "s1").state)).toBe(false);
    expect(nothingOpen(openRun(s, "run-1").state)).toBe(false);
    expect(nothingOpen(openSettings(s))).toBe(false);
    expect(nothingOpen(openRuns(s))).toBe(false);
  });

  it("is true again once the last tab closes", () => {
    let s = openRun(initialWorkspaceState(), "run-1").state;
    s = closeTab(s, tabKey("run", "run-1"));
    expect(nothingOpen(s)).toBe(true);
  });
});

describe("run tabs", () => {
  it("reuses the last run tab so a debug loop does not eat the cap", () => {
    // A suite is a template and a run is an instance. Pressing Run five times chasing a
    // failure must not cost five tabs.
    let s = openSuite(initialWorkspaceState(), "s1").state;
    s = openRun(s, "run-1").state;
    s = openRun(s, "run-2").state;
    s = openRun(s, "run-3").state;

    expect(s.tabs.filter((t) => t.kind === "run").map((t) => t.id)).toEqual(["run-3"]);
    expect(s.active).toBe(tabKey("run", "run-3"));
    // The suite it came from is untouched.
    expect(s.tabs.some((t) => t.kind === "suite" && t.id === "s1")).toBe(true);
  });

  it("keeps a pinned run and opens the next beside it", () => {
    // Pinning is the only way to compare a run against the next one.
    let s = openRun(initialWorkspaceState(), "run-1").state;
    s = togglePinned(s, tabKey("run", "run-1"));
    s = openRun(s, "run-2").state;

    expect(s.tabs.map((t) => t.id)).toEqual(["run-1", "run-2"]);
    // And the newest is still the unpinned one that gets replaced next time.
    s = openRun(s, "run-3").state;
    expect(s.tabs.map((t) => t.id)).toEqual(["run-1", "run-3"]);
  });

  it("just activates a run that is already open", () => {
    let s = openRun(initialWorkspaceState(), "run-1").state;
    s = togglePinned(s, tabKey("run", "run-1"));
    s = openRun(s, "run-2").state;
    s = openRun(s, "run-1").state;

    expect(s.tabs).toHaveLength(2);
    expect(s.active).toBe(tabKey("run", "run-1"));
  });

  it("respects the cap once every run tab is pinned", () => {
    let s = initialWorkspaceState();
    for (let i = 0; i < MAX_TABS; i++) {
      s = openRun(s, `run-${i}`).state;
      s = togglePinned(s, tabKey("run", `run-${i}`));
    }
    expect(atCap(s)).toBe(true);

    const { state, capped } = openRun(s, "run-overflow");
    expect(capped).toBe(true);
    expect(tabCount(state)).toBe(MAX_TABS);
  });

  it("closes like any other tab", () => {
    let s = openFlow(initialWorkspaceState(), "f1").state;
    s = openRun(s, "run-1").state;
    s = closeTab(s, tabKey("run", "run-1"));
    expect(s.tabs.map((t) => t.kind)).toEqual(["flow"]);
    expect(s.active).toBe(tabKey("flow", "f1"));
  });
});

describe("the runs tab", () => {
  it("is a singleton, like settings", () => {
    expect(isSingleton("runs")).toBe(true);
    expect(isSingleton("settings")).toBe(true);
    expect(isSingleton("flow:f1")).toBe(false);

    let s = openRuns(initialWorkspaceState());
    expect(s.runsOpen).toBe(true);
    expect(s.active).toBe("runs");
    // Opening it twice is opening it once — there is one history, not one per click.
    s = openRuns(s);
    expect(s.runsOpen).toBe(true);
    expect(s.tabs).toEqual([]);
  });

  it("closing it falls back to the last ordinary tab", () => {
    let s = openFlow(initialWorkspaceState(), "f1").state;
    s = openRuns(s);
    s = closeTab(s, "runs");
    expect(s.runsOpen).toBe(false);
    expect(s.active).toBe(tabKey("flow", "f1"));
  });

  it("is never offered as its own fallback", () => {
    // The bug this guards: closing the active runs tab and landing back on it, so the
    // close button appears to do nothing.
    let s = openRuns(initialWorkspaceState());
    s = closeTab(s, "runs");
    expect(s.active).toBeNull();
  });

  it("catches focus when the last ordinary tab closes", () => {
    let s = openFlow(initialWorkspaceState(), "f1").state;
    s = openRuns(s);
    s = setActive(s, tabKey("flow", "f1"));
    s = closeTab(s, tabKey("flow", "f1"));
    expect(s.active).toBe("runs");
  });

  it("coexists with settings without either closing the other", () => {
    let s = openSettings(initialWorkspaceState());
    s = openRuns(s);
    expect(s.settingsOpen).toBe(true);
    expect(s.runsOpen).toBe(true);

    s = closeTab(s, "runs");
    expect(s.settingsOpen).toBe(true);
    expect(s.active).toBe("settings");
  });
});
