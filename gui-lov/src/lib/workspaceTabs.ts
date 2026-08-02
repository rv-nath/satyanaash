/**
 * Workspace tab model (Plan: settings-as-a-tab + tests-primary).
 *
 * Tabs are flow or test tabs (ordered), plus a singleton Settings tab. There is
 * no permanent/pinned tab; when nothing is open the workspace shows an empty
 * placeholder (`active === null`). Flow tabs follow VS Code "preview tab"
 * semantics: opening a flow reuses the active flow tab if it's unedited
 * (`canReuseActive`), otherwise opens a new tab. Flow+test tabs are capped at
 * MAX_TABS (settings excluded).
 */
export const MAX_TABS = 8;

export type TabKind = "flow" | "test" | "suite" | "run";

export interface OpenTab {
  kind: TabKind;
  id: string;
  /**
   * Run tabs only: keep this one when the next run opens.
   *
   * A suite is a template and a run is an instance, so runs accumulate fast — a debug
   * loop would eat the tab cap in minutes. The newest run replaces the last unpinned run
   * tab; pinning is how you hold one back to compare against the next.
   */
  pinned?: boolean;
}

/**
 * Surfaces there is only ever one of, whatever the project holds.
 *
 * Settings is one screen because a project has one set of them. Run history is one screen
 * for the same reason: it is the record of the whole project, not a property of any flow
 * or suite in it — a history tab per suite would fragment the one view where comparing
 * across them is the point.
 */
export type SingletonTab = "settings" | "runs";

const SINGLETONS: SingletonTab[] = ["settings", "runs"];

export function isSingleton(key: string): key is SingletonTab {
  return (SINGLETONS as string[]).includes(key);
}

/** active is a tab key ("flow:<id>" | "test:<id>" | "suite:<id>"), a singleton key, or
 *  null (empty). */
export interface WorkspaceState {
  tabs: OpenTab[];
  settingsOpen: boolean;
  runsOpen: boolean;
  active: string | null;
}

/** Result of an open* action; `capped` is set when the tab limit blocked it. */
export interface OpenResult {
  state: WorkspaceState;
  capped?: boolean;
}

export function tabKey(kind: TabKind, id: string): string {
  return `${kind}:${id}`;
}

export function initialWorkspaceState(): WorkspaceState {
  return { tabs: [], settingsOpen: false, runsOpen: false, active: null };
}

export function tabCount(state: WorkspaceState): number {
  return state.tabs.length;
}

export function atCap(state: WorkspaceState): boolean {
  return state.tabs.length >= MAX_TABS;
}

export function setActive(state: WorkspaceState, key: string): WorkspaceState {
  return { ...state, active: key };
}

function has(state: WorkspaceState, kind: TabKind, id: string): boolean {
  return state.tabs.some((t) => t.kind === kind && t.id === id);
}

export function openTest(state: WorkspaceState, id: string): OpenResult {
  const key = tabKey("test", id);
  if (has(state, "test", id)) return { state: setActive(state, key) };
  if (atCap(state)) return { state, capped: true };
  return { state: { ...state, tabs: [...state.tabs, { kind: "test", id }], active: key } };
}

export function openFlow(
  state: WorkspaceState,
  id: string,
  opts: { canReuseActive?: boolean } = {}
): OpenResult {
  const key = tabKey("flow", id);
  if (has(state, "flow", id)) return { state: setActive(state, key) };

  // Reuse the active flow tab if it is unedited.
  if (opts.canReuseActive && state.active && state.active.startsWith("flow:")) {
    const idx = state.tabs.findIndex((t) => tabKey(t.kind, t.id) === state.active);
    if (idx !== -1) {
      const tabs = state.tabs.slice();
      tabs[idx] = { kind: "flow", id };
      return { state: { ...state, tabs, active: key } };
    }
  }

  if (atCap(state)) return { state, capped: true };
  return { state: { ...state, tabs: [...state.tabs, { kind: "flow", id }], active: key } };
}

export function openSuite(state: WorkspaceState, id: string): OpenResult {
  const key = tabKey("suite", id);
  if (has(state, "suite", id)) return { state: setActive(state, key) };
  if (atCap(state)) return { state, capped: true };
  return { state: { ...state, tabs: [...state.tabs, { kind: "suite", id }], active: key } };
}

/**
 * Open a run, reusing the last unpinned run tab.
 *
 * Runs are instances, not documents: pressing Run five times while chasing a failure
 * should not cost five tabs. The reused slot is the *last* run tab rather than the active
 * one — you are usually looking at the suite when you press Run, so there is no active run
 * tab to reuse, and the one you want replaced is the previous run.
 */
export function openRun(state: WorkspaceState, id: string): OpenResult {
  const key = tabKey("run", id);
  if (has(state, "run", id)) return { state: setActive(state, key) };

  const reusable = state.tabs.map((t, i) => ({ t, i })).filter(({ t }) => t.kind === "run" && !t.pinned).pop();
  if (reusable) {
    const tabs = state.tabs.slice();
    tabs[reusable.i] = { kind: "run", id };
    return { state: { ...state, tabs, active: key } };
  }

  if (atCap(state)) return { state, capped: true };
  return { state: { ...state, tabs: [...state.tabs, { kind: "run", id }], active: key } };
}

/** Hold a run tab back so the next run opens beside it instead of over it. */
export function togglePinned(state: WorkspaceState, key: string): WorkspaceState {
  const tabs = state.tabs.map((t) =>
    tabKey(t.kind, t.id) === key ? { ...t, pinned: !t.pinned } : t
  );
  return { ...state, tabs };
}

export function openSettings(state: WorkspaceState): WorkspaceState {
  return { ...state, settingsOpen: true, active: "settings" };
}

export function openRuns(state: WorkspaceState): WorkspaceState {
  return { ...state, runsOpen: true, active: "runs" };
}

/**
 * Where focus lands when the active tab goes away: the last ordinary tab, else whichever
 * singleton is still open, else nothing.
 *
 * Settings is preferred over runs only because it was here first and its behaviour is
 * already pinned by tests — neither is a better landing place than the other.
 */
function fallbackActive(state: WorkspaceState, tabs: OpenTab[]): string | null {
  if (tabs.length) {
    const last = tabs[tabs.length - 1];
    return tabKey(last.kind, last.id);
  }
  if (state.settingsOpen) return "settings";
  if (state.runsOpen) return "runs";
  return null;
}

export function closeTab(state: WorkspaceState, key: string): WorkspaceState {
  if (isSingleton(key)) {
    // Closed first, so it can't be offered as its own fallback.
    const closed: WorkspaceState = {
      ...state,
      settingsOpen: key === "settings" ? false : state.settingsOpen,
      runsOpen: key === "runs" ? false : state.runsOpen,
    };
    const active = state.active === key ? fallbackActive(closed, closed.tabs) : state.active;
    return { ...closed, active };
  }

  const idx = state.tabs.findIndex((t) => tabKey(t.kind, t.id) === key);
  if (idx === -1) return state;
  const tabs = state.tabs.filter((_, i) => i !== idx);

  let active = state.active;
  if (state.active === key) {
    if (tabs.length === 0) {
      active = fallbackActive(state, tabs);
    } else if (idx < tabs.length) {
      active = tabKey(tabs[idx].kind, tabs[idx].id); // right neighbor took this index
    } else {
      active = tabKey(tabs[tabs.length - 1].kind, tabs[tabs.length - 1].id); // was last → left
    }
  }
  return { ...state, tabs, active };
}
