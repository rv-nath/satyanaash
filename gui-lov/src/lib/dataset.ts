/**
 * Pure reducers for a test case's data-driven rows.
 *
 * All grid mutation lives here rather than in the component, so the fiddly parts
 * — rekeying every row when a column is renamed, dropping orphaned cells when a
 * column goes — are unit-testable without rendering anything.
 */
import type { DataRow, Dataset } from "@/lib/api/types";

export const emptyDataset = (): Dataset => ({ columns: [], rows: [] });

export const isEmptyDataset = (d: Dataset): boolean =>
  d.rows.length === 0 && d.columns.length === 0;

export const newRowId = (): string =>
  `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Column names become `{{name}}` variables, and the interpolation regex only
 * accepts word characters — so a name with a space or a leading digit would
 * silently never resolve. Reject it at authoring time instead.
 */
export const isValidColumnName = (name: string): boolean => /^[A-Za-z_]\w*$/.test(name);

/** A column name that isn't already taken (`column`, `column_2`, …). */
export function suggestColumnName(d: Dataset): string {
  if (!d.columns.includes("column")) return "column";
  let n = 2;
  while (d.columns.includes(`column_${n}`)) n += 1;
  return `column_${n}`;
}

export function addColumn(d: Dataset, name?: string): Dataset {
  const col = name ?? suggestColumnName(d);
  if (d.columns.includes(col)) return d;
  return {
    columns: [...d.columns, col],
    // Give every existing row an empty cell so the grid stays rectangular.
    rows: d.rows.map((r) => ({ ...r, values: { ...r.values, [col]: "" } })),
  };
}

/** Rename a column *and* rekey it in every row, so no cell is orphaned. */
export function renameColumn(d: Dataset, from: string, to: string): Dataset {
  if (from === to) return d;
  // Refuse a collision rather than silently merging two columns' values.
  if (d.columns.includes(to)) return d;
  return {
    columns: d.columns.map((c) => (c === from ? to : c)),
    rows: d.rows.map((r) => {
      const { [from]: moved, ...rest } = r.values;
      return { ...r, values: { ...rest, [to]: moved ?? "" } };
    }),
  };
}

/** Drop a column and every row's value for it. */
export function removeColumn(d: Dataset, name: string): Dataset {
  return {
    columns: d.columns.filter((c) => c !== name),
    rows: d.rows.map((r) => {
      const { [name]: _dropped, ...rest } = r.values;
      return { ...r, values: rest };
    }),
  };
}

export function addRow(d: Dataset): Dataset {
  const values: Record<string, string> = {};
  for (const c of d.columns) values[c] = "";
  const row: DataRow = { id: newRowId(), name: "", values, assertion: "" };
  return { ...d, rows: [...d.rows, row] };
}

export function removeRow(d: Dataset, rowId: string): Dataset {
  return { ...d, rows: d.rows.filter((r) => r.id !== rowId) };
}

const patchRow = (d: Dataset, rowId: string, patch: Partial<DataRow>): Dataset => ({
  ...d,
  rows: d.rows.map((r) => (r.id === rowId ? { ...r, ...patch } : r)),
});

export function setCell(d: Dataset, rowId: string, column: string, value: string): Dataset {
  const row = d.rows.find((r) => r.id === rowId);
  if (!row) return d;
  return patchRow(d, rowId, { values: { ...row.values, [column]: value } });
}

export function setRowName(d: Dataset, rowId: string, name: string): Dataset {
  return patchRow(d, rowId, { name });
}

export function setRowAssertion(d: Dataset, rowId: string, assertion: string): Dataset {
  return patchRow(d, rowId, { assertion });
}

/** Label shown in the results matrix — mirrors the server's Dataset::label_for. */
export function rowLabel(index: number, row: DataRow): string {
  const name = (row.name ?? "").trim();
  return name || `Row ${index + 1}`;
}
