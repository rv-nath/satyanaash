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
  const row: DataRow = { id: newRowId(), name: "", body: "", check: "" };
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
