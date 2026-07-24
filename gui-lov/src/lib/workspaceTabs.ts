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

export type TabKind = "flow" | "test";

export interface OpenTab {
  kind: TabKind;
  id: string;
}

/** active is a tab key ("flow:<id>" | "test:<id>"), "settings", or null (empty). */
export interface WorkspaceState {
  tabs: OpenTab[];
  settingsOpen: boolean;
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
  return { tabs: [], settingsOpen: false, active: null };
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

export function openSettings(state: WorkspaceState): WorkspaceState {
  return { ...state, settingsOpen: true, active: "settings" };
}

export function closeTab(state: WorkspaceState, key: string): WorkspaceState {
  if (key === "settings") {
    let active = state.active;
    if (state.active === "settings") {
      active = state.tabs.length
        ? tabKey(state.tabs[state.tabs.length - 1].kind, state.tabs[state.tabs.length - 1].id)
        : null;
    }
    return { ...state, settingsOpen: false, active };
  }

  const idx = state.tabs.findIndex((t) => tabKey(t.kind, t.id) === key);
  if (idx === -1) return state;
  const tabs = state.tabs.filter((_, i) => i !== idx);

  let active = state.active;
  if (state.active === key) {
    if (tabs.length === 0) {
      active = state.settingsOpen ? "settings" : null;
    } else if (idx < tabs.length) {
      active = tabKey(tabs[idx].kind, tabs[idx].id); // right neighbor took this index
    } else {
      active = tabKey(tabs[tabs.length - 1].kind, tabs[tabs.length - 1].id); // was last → left
    }
  }
  return { ...state, tabs, active };
}
