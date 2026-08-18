/**
 * Pure reducers for a test case's data-driven rows.
 *
 * A row is one case: a label, the body to send, and the status expected back.
 * There are deliberately no named columns — the author pastes exactly what goes
 * on the wire, so there is no template-variable model to learn.
 */
import type { DataRow, Dataset, RowHeader } from "@/lib/api/types";

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
 * The `{{names}}` in one string, minus `$`-built-ins. The regex mirrors `template_names` on the
 * server, including its "no dots" rule.
 *
 * `skipLeading` drops a placeholder the text *starts* with — the base-URL rule, which belongs to
 * the endpoint alone.
 */
function placeholderNames(text: string, skipLeading: boolean): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/\{\{(\$?\w+)(?:\(([^)]*)\))?\}\}/g)) {
    const name = match[1];
    if (name.startsWith("$")) continue;
    if (skipLeading && match.index === 0) continue;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * The `{{names}}` in an endpoint that a data row can usefully fill in.
 *
 * The **only** source of row columns. It briefly also derived them from header values, so that a
 * templated `Authorization: {{bad_auth}}` would show up — but that variable was a workaround for
 * rows not carrying headers, and naming a column after it put a project's private invention in
 * the framework's furniture. Rows carry headers now (`DataRow.headers`), so the workaround, and
 * the column derived from it, are both gone. An endpoint placeholder is different in kind: the
 * author wrote it in the URL, and it is a parameter of the request.
 *
 * Two names are left out:
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
  return placeholderNames(endpoint.trim(), true);
}

/**
 * What a row's parameter cell reads as, collapsed.
 *
 * The generic `Parameters` column replaced one column per declared name, so this is the only
 * thing standing between the author and "a row sets something, but not what". An icon would have
 * said less than nothing there.
 *
 * Two forms, and the difference is about ambiguity rather than brevity:
 *
 * - **One name declared** → the bare value. There is nothing to confuse it with, and the column
 *   then reads exactly like the value column it replaced.
 * - **Several declared** → `name=value`, because values alone cannot say *which* name they
 *   filled. With three names and only the second one set, a bare `c-123` is a riddle.
 *
 * Declaration order throughout, never the order the row's map happens to hold — the author reads
 * these names off the URL in order, and a preview that reordered them would not be comparable
 * down the column, which is the one job it has.
 *
 * Blank when the row sets nothing: the caller says what an empty cell *means*, in prose.
 */
export function rowPreview(row: DataRow, names: string[]): string {
  const set = names.filter((n) => (row.vars?.[n] ?? "").trim());
  if (set.length === 0) return "";
  if (names.length === 1) return row.vars![names[0]];
  return set.map((n) => `${n}=${row.vars![n]}`).join(" · ");
}

/* ── A row's own headers ─────────────────────────────────────────────────────────────────
 *
 * Everything else about a request could already be varied per row; headers could not, and
 * headers are where credentials live. These are the reducers behind that, kept pure so the
 * merge rule can be tested against plain values — it has to agree with the engine's, and the
 * engine's is the one that decides what goes on the wire.
 */

/** Case-insensitive, because HTTP header names are. Used everywhere a key is looked up, so a
 *  row typing `authorization` and a request declaring `Authorization` are the same header. */
const sameKey = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The row's own entry for a key, if it has one. */
export const rowHeader = (row: DataRow, key: string): RowHeader | undefined =>
  (row.headers ?? []).find((h) => sameKey(h.key, key));

const patchHeaders = (d: Dataset, rowId: string, next: (hs: RowHeader[]) => RowHeader[]): Dataset =>
  patchRow(d, rowId, { headers: next([...((d.rows.find((r) => r.id === rowId)?.headers ?? []))]) });

/**
 * Set this row's value for a header, adding the entry if it had none.
 *
 * Ticked by definition: setting a value is an override. Suppression is a separate act, because
 * blank cannot mean it — blank means "unset" everywhere else in this model.
 */
export function setRowHeader(d: Dataset, rowId: string, key: string, value: string): Dataset {
  return patchHeaders(d, rowId, (hs) => {
    const at = hs.findIndex((h) => sameKey(h.key, key));
    if (at === -1) return [...hs, { key, value, enabled: true }];
    hs[at] = { ...hs[at], value, enabled: true };
    return hs;
  });
}

/** Rename a header this row alone sends. Only meaningful for a row-only entry: renaming an
 *  override would silently stop overriding the header it was pointed at. */
export function renameRowHeader(d: Dataset, rowId: string, key: string, to: string): Dataset {
  return patchHeaders(d, rowId, (hs) => {
    const at = hs.findIndex((h) => sameKey(h.key, key));
    if (at === -1) return hs;
    hs[at] = { ...hs[at], key: to };
    return hs;
  });
}

/**
 * Send this header, or don't.
 *
 * Unticking keeps the value, so the credential does not have to be retyped to bring it back —
 * and an entry that exists only to suppress carries a blank value, which is fine because
 * `enabled: false` is what the engine reads.
 */
export function suppressRowHeader(d: Dataset, rowId: string, key: string, suppressed: boolean): Dataset {
  return patchHeaders(d, rowId, (hs) => {
    const at = hs.findIndex((h) => sameKey(h.key, key));
    if (at === -1) return [...hs, { key, value: "", enabled: !suppressed }];
    hs[at] = { ...hs[at], enabled: !suppressed };
    return hs;
  });
}

/** Drop the row's entry, so the header goes back to whatever the request says. Distinct from
 *  suppressing: this is "I have nothing to say about it", not "don't send it". */
export function clearRowHeader(d: Dataset, rowId: string, key: string): Dataset {
  return patchHeaders(d, rowId, (hs) => hs.filter((h) => !sameKey(h.key, key)));
}

/** Somewhere to type a header only this case sends. Blank, and ignored by the engine until it
 *  has a name. */
export function addRowHeader(d: Dataset, rowId: string): Dataset {
  return patchHeaders(d, rowId, (hs) => [...hs, { key: "", value: "", enabled: true }]);
}

/** Where a header in a row's editor came from, and what the row did about it. */
export type HeaderOrigin = "inherited" | "overridden" | "suppressed" | "row-only";

export interface EffectiveHeader {
  key: string;
  /** What will actually be sent — the request's value, or the row's if it overrode it. Empty
   *  for a suppressed header, which is sent not at all. */
  value: string;
  origin: HeaderOrigin;
}

/**
 * What this row actually sends, and why each header is there.
 *
 * **Mirrors the engine's merge** (`run_once`): the request's headers, then the row's over the
 * top by key, case-insensitively, with an unticked entry removing rather than replacing. The
 * author needs to read what the row sends, not only what it changes — a screen that showed only
 * the overrides would leave them holding two lists and doing this in their head.
 *
 * Request order first, so the list does not reshuffle as a row overrides things; then whatever
 * the row adds on its own.
 */
export function effectiveHeaders(
  requestHeaders: { key: string; value: string; enabled?: boolean }[] | undefined | null,
  row: DataRow,
): EffectiveHeader[] {
  const inherited = (requestHeaders ?? []).filter((h) => h.enabled !== false && h.key.trim());
  const own = (row.headers ?? []).filter((h) => h.key.trim());
  const out: EffectiveHeader[] = inherited.map((h) => {
    const mine = own.find((o) => sameKey(o.key, h.key));
    if (!mine) return { key: h.key, value: h.value, origin: "inherited" };
    if (mine.enabled === false) return { key: h.key, value: "", origin: "suppressed" };
    return { key: h.key, value: mine.value, origin: "overridden" };
  });
  for (const mine of own) {
    if (inherited.some((h) => sameKey(h.key, mine.key))) continue;
    // A suppression of a header the request does not send is inert, and saying so is kinder than
    // showing it as though it were doing something.
    out.push({
      key: mine.key,
      value: mine.enabled === false ? "" : mine.value,
      origin: mine.enabled === false ? "suppressed" : "row-only",
    });
  }
  return out;
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
