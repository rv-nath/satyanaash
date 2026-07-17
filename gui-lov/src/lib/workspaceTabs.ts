export type WorkspaceTab = "canvas" | string;

export interface WorkspaceState {
  openTestIds: string[];
  active: WorkspaceTab;
}

export function initialWorkspaceState(): WorkspaceState {
  return { openTestIds: [], active: "canvas" };
}

export function openTestTab(state: WorkspaceState, id: string): WorkspaceState {
  const openTestIds = state.openTestIds.includes(id)
    ? state.openTestIds
    : [...state.openTestIds, id];
  return { openTestIds, active: id };
}

export function setActive(state: WorkspaceState, tab: WorkspaceTab): WorkspaceState {
  return { ...state, active: tab };
}

export function switchFlow(state: WorkspaceState): WorkspaceState {
  return { ...state, active: "canvas" };
}

export function closeTestTab(state: WorkspaceState, id: string): WorkspaceState {
  const idx = state.openTestIds.indexOf(id);
  if (idx === -1) return state;
  const openTestIds = state.openTestIds.filter((t) => t !== id);

  let active = state.active;
  if (state.active === id) {
    if (openTestIds.length === 0) {
      active = "canvas";
    } else if (idx < openTestIds.length) {
      active = openTestIds[idx]; // right neighbor took this index
    } else {
      active = openTestIds[openTestIds.length - 1]; // was last → left neighbor
    }
  }
  return { openTestIds, active };
}
