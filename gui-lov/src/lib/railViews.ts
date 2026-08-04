/**
 * What the left sidebar is showing.
 *
 * The sidebar grew by stacking: three lists in one vertical group inside a 200–300px
 * column, which left Suites about two rows of height and had no room at all for Runs. The
 * rail stops showing everything at once — it picks one view, and a dedicated view gets the
 * whole column.
 *
 * **Settings is deliberately not one of these.** It opens its own workspace tab, because
 * `SettingsPanel` already carries a section nav on its left edge and a sidebar copy would
 * duplicate it. Keeping it out of this union is what makes that a compile-time fact rather
 * than a convention — a rail entry that switched the sidebar to "settings" would land you
 * on a view with nothing in it.
 */
export const RAIL_VIEWS = [
  {
    id: "workspace",
    label: "Workspace",
    /** Tests, Flows and Suites stacked — what the sidebar has always shown. */
    hint: "Tests, flows and suites together",
  },
  { id: "tests", label: "Tests", hint: "Every request in this project" },
  { id: "flows", label: "Flows", hint: "Every flow in this project" },
  { id: "suites", label: "Suites", hint: "Sets of flows and requests to run together" },
  { id: "runs", label: "Runs", hint: "Recent runs — open one without leaving the canvas" },
] as const;

export type RailView = (typeof RAIL_VIEWS)[number]["id"];

export const DEFAULT_RAIL_VIEW: RailView = "workspace";

export function isRailView(value: unknown): value is RailView {
  return RAIL_VIEWS.some((v) => v.id === value);
}

/**
 * A stored view id, or the default.
 *
 * Anything unrecognised falls back rather than being trusted: a view removed in a later
 * version, or a hand-edited value, would otherwise leave the sidebar blank with no way to
 * get out of it except clearing storage.
 */
export function railViewFrom(stored: string | null): RailView {
  return isRailView(stored) ? stored : DEFAULT_RAIL_VIEW;
}

export function railViewLabel(view: RailView): string {
  return RAIL_VIEWS.find((v) => v.id === view)!.label;
}
