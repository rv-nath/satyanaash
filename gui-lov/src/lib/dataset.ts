/**
 * Pure reducers for a test case's data-driven rows.
 *
 * A row is one case: a label, the body to send, and the status expected back.
 * There are deliberately no named columns — the author pastes exactly what goes
 * on the wire, so there is no template-variable model to learn.
 */
import type { DataRow, Dataset } from "@/lib/api/types";

export const emptyDataset = (): Dataset => ({ rows: [] });

export const isEmptyDataset = (d: Dataset): boolean => d.rows.length === 0;

export const newRowId = (): string =>
  `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function addRow(d: Dataset): Dataset {
  const row: DataRow = { id: newRowId(), name: "", path: "", body: "", check: "" };
  return { rows: [...d.rows, row] };
}

export function removeRow(d: Dataset, rowId: string): Dataset {
  return { rows: d.rows.filter((r) => r.id !== rowId) };
}

const patchRow = (d: Dataset, rowId: string, patch: Partial<DataRow>): Dataset => ({
  rows: d.rows.map((r) => (r.id === rowId ? { ...r, ...patch } : r)),
});

export function setRowName(d: Dataset, rowId: string, name: string): Dataset {
  return patchRow(d, rowId, { name });
}

export function setRowBody(d: Dataset, rowId: string, body: string): Dataset {
  return patchRow(d, rowId, { body });
}

export function setRowCheck(d: Dataset, rowId: string, check: string): Dataset {
  return patchRow(d, rowId, { check });
}

export function setRowPath(d: Dataset, rowId: string, path: string): Dataset {
  return patchRow(d, rowId, { path });
}

export function setRowNeedsFlow(d: Dataset, rowId: string, needs_flow: boolean): Dataset {
  return patchRow(d, rowId, { needs_flow });
}

/** Set one of a row's values for the request's own `{{names}}`. A blank clears it, so
 *  the name falls back through the normal tiers rather than sending an empty segment. */
export function setRowVar(d: Dataset, rowId: string, name: string, value: string): Dataset {
  return {
    rows: d.rows.map((r) => {
      if (r.id !== rowId) return r;
      const vars = { ...(r.vars ?? {}) };
      if (value.trim()) vars[name] = value;
      else delete vars[name];
      return { ...r, vars };
    }),
  };
}

/** This row's value for a name, or "" if it doesn't set one. */
export const rowVar = (row: DataRow, name: string): string => row.vars?.[name] ?? "";

/**
 * The `{{names}}` in an endpoint that a data row can usefully fill in.
 *
 * Mirrors `template_names` on the server — the same regex, and the same "no dots"
 * rule. Two names are left out:
 *
 * - **Built-ins** (`{{$UUID}}`, `{{$RandomEmail}}`): generated per use, so there is
 *   nothing for a row to say about them.
 * - **A placeholder the endpoint *starts* with**, which is the base URL. Every endpoint
 *   in the project begins `{{baseUrl}}/…`, and a column for it in every dataset would
 *   be noise. A placeholder anywhere else is a parameter of the request.
 *
 * Duplicates collapse: `/{{id}}/children/{{id}}` is one column.
 */
export function pathVariables(endpoint: string | undefined | null): string[] {
  if (!endpoint) return [];
  const trimmed = endpoint.trim();
  const names: string[] = [];
  const re = /\{\{(\$?\w+)(?:\(([^)]*)\))?\}\}/g;
  for (const match of trimmed.matchAll(re)) {
    const name = match[1];
    if (name.startsWith("$")) continue;
    if (match.index === 0) continue; // the base URL, not a parameter
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Park a row while it's being drafted, or bring it back. */
export function setRowDisabled(d: Dataset, rowId: string, disabled: boolean): Dataset {
  return patchRow(d, rowId, { disabled });
}

/** The rows "Run dataset" will actually send: parked rows run nowhere, and the rest of
 *  the skips need a flow to satisfy them. */
export const runnableAlone = (d: Dataset): DataRow[] =>
  d.rows.filter((r) => !r.needs_flow && !r.disabled);

/** The rows a flow node will send. A flow satisfies `needs_flow`, but nothing revives a
 *  parked row. */
export const runnableInFlow = (d: Dataset): DataRow[] => d.rows.filter((r) => !r.disabled);

/**
 * What the "Run dataset" button counts.
 *
 * A bare total when every row will run, and a fraction when some won't — "17" beside a
 * button that sends 2 requests is a lie, and "17/17" is noise. Same rule as the row
 * markers: say something only when there is something to say.
 */
export function runnableLabel(d: Dataset): string {
  const runnable = runnableAlone(d).length;
  return runnable === d.rows.length ? `${runnable}` : `${runnable}/${d.rows.length}`;
}

/** How a row's suffix will join the request's endpoint — shown as a hint, and
 *  mirroring `resolve_endpoint` on the server. A row adding "?org=acme" to an
 *  endpoint that already has a query joins with "&", because "?limit=10?org=acme"
 *  is one broken parameter rather than two. */
export function joinEndpoint(endpoint: string, path: string): string {
  const suffix = path.trim();
  if (!suffix) return endpoint;
  return suffix.startsWith("?") && endpoint.includes("?")
    ? `${endpoint}&${suffix.slice(1)}`
    : `${endpoint}${suffix}`;
}

/** True when a check is nothing but a status code — the shorthand form. Anything
 *  else is sent to the engine as a Rhai expression. Mirrors DataRow::
 *  expected_status_code on the server. */
export function isStatusShorthand(check: string): boolean {
  return /^\d+$/.test(check.trim());
}

/** A one-line form of a cell, for the collapsed row. A pretty-printed body would
 *  otherwise show as a lone "{", so JSON is minified; anything else just loses
 *  its line breaks. Display only — the stored text is never rewritten. */
export function oneLine(text: string): string {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.stringify(JSON.parse(t));
    } catch {
      // Malformed JSON still deserves a preview — fall through.
    }
  }
  return t.replace(/\s+/g, " ");
}

/** Duplicate a row — the usual way to build a matrix is tweak-and-repeat. */
export function duplicateRow(d: Dataset, rowId: string): Dataset {
  const i = d.rows.findIndex((r) => r.id === rowId);
  if (i < 0) return d;
  const copy: DataRow = { ...d.rows[i], id: newRowId() };
  const rows = [...d.rows];
  rows.splice(i + 1, 0, copy);
  return { rows };
}

/** True when the text isn't valid JSON — surfaced as a hint, never blocking:
 *  a non-JSON body is legitimate (form data, deliberately malformed input). */
export function looksLikeInvalidJson(body: string): boolean {
  const t = body.trim();
  if (!t) return false;
  if (!(t.startsWith("{") || t.startsWith("["))) return false;
  try {
    JSON.parse(t);
    return false;
  } catch {
    return true;
  }
}

/** Label shown in the results matrix — mirrors the server's Dataset::label_for. */
export function rowLabel(index: number, row: DataRow): string {
  const name = (row.name ?? "").trim();
  return name || `Row ${index + 1}`;
}
