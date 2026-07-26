import { describe, it, expect } from "vitest";
import {
  addColumn,
  addRow,
  emptyDataset,
  isEmptyDataset,
  isValidColumnName,
  removeColumn,
  removeRow,
  renameColumn,
  rowLabel,
  setCell,
  setRowAssertion,
  setRowName,
  setRowPayload,
  setRowPayloadMode,
  rowOverrides,
  suggestColumnName,
} from "@/lib/dataset";
import type { Dataset } from "@/lib/api/types";

/** A 2-column, 2-row grid to mutate. */
function seed(): Dataset {
  let d = emptyDataset();
  d = addColumn(d, "email");
  d = addColumn(d, "expected_status");
  d = addRow(d);
  d = addRow(d);
  d = setCell(d, d.rows[0].id, "email", "a@x.com");
  d = setCell(d, d.rows[0].id, "expected_status", "201");
  d = setCell(d, d.rows[1].id, "email", "");
  d = setCell(d, d.rows[1].id, "expected_status", "400");
  return d;
}

describe("dataset reducers", () => {
  it("starts empty", () => {
    expect(isEmptyDataset(emptyDataset())).toBe(true);
    expect(isEmptyDataset(seed())).toBe(false);
  });

  it("gives new rows a cell for every column", () => {
    const d = addRow(seed());
    expect(Object.keys(d.rows[2].values).sort()).toEqual(["email", "expected_status"]);
    expect(d.rows[2].values.email).toBe("");
  });

  it("gives existing rows a cell when a column is added", () => {
    const d = addColumn(seed(), "mobile");
    expect(d.rows.every((r) => "mobile" in r.values)).toBe(true);
  });

  it("refuses a duplicate column", () => {
    const d = seed();
    expect(addColumn(d, "email")).toBe(d);
  });

  it("suggests a free column name", () => {
    let d = emptyDataset();
    expect(suggestColumnName(d)).toBe("column");
    d = addColumn(d, "column");
    expect(suggestColumnName(d)).toBe("column_2");
    d = addColumn(d, "column_2");
    expect(suggestColumnName(d)).toBe("column_3");
  });

  it("rekeys every row when a column is renamed", () => {
    const d = renameColumn(seed(), "email", "user_email");
    expect(d.columns).toEqual(["user_email", "expected_status"]);
    // The value moved with the column and the old key is gone.
    expect(d.rows[0].values.user_email).toBe("a@x.com");
    expect("email" in d.rows[0].values).toBe(false);
  });

  it("keeps column order when renaming", () => {
    const d = renameColumn(seed(), "expected_status", "want");
    expect(d.columns).toEqual(["email", "want"]);
  });

  it("refuses a rename that would collide", () => {
    const d = seed();
    expect(renameColumn(d, "email", "expected_status")).toBe(d);
  });

  it("leaves no orphaned cells when a column is removed", () => {
    const d = removeColumn(seed(), "email");
    expect(d.columns).toEqual(["expected_status"]);
    expect(d.rows.every((r) => !("email" in r.values))).toBe(true);
  });

  it("removes a row by id", () => {
    const d = seed();
    const gone = d.rows[0].id;
    const next = removeRow(d, gone);
    expect(next.rows).toHaveLength(1);
    expect(next.rows.find((r) => r.id === gone)).toBeUndefined();
  });

  it("sets cell, name and assertion without touching other rows", () => {
    const d = seed();
    const id = d.rows[0].id;
    let next = setCell(d, id, "email", "z@x.com");
    next = setRowName(next, id, "happy path");
    next = setRowAssertion(next, id, "response.status == 201");

    expect(next.rows[0].values.email).toBe("z@x.com");
    expect(next.rows[0].name).toBe("happy path");
    expect(next.rows[0].assertion).toBe("response.status == 201");
    // Second row untouched.
    expect(next.rows[1]).toEqual(d.rows[1]);
  });

  it("only accepts column names usable as {{variables}}", () => {
    // The interpolation regex is \w+ only — anything else silently never resolves.
    expect(isValidColumnName("email")).toBe(true);
    expect(isValidColumnName("expected_status")).toBe(true);
    expect(isValidColumnName("_private")).toBe(true);
    expect(isValidColumnName("expected status")).toBe(false);
    expect(isValidColumnName("2nd")).toBe(false);
    expect(isValidColumnName("a-b")).toBe(false);
    expect(isValidColumnName("")).toBe(false);
  });

  it("defaults new rows to the shared payload", () => {
    const d = addRow(emptyDataset());
    expect(d.rows[0].payload_mode).toBe("shared");
  });

  it("tracks payload mode and body per row", () => {
    const d = seed();
    const id = d.rows[0].id;
    let next = setRowPayloadMode(d, id, "custom");
    next = setRowPayload(next, id, "{}");

    expect(next.rows[0].payload_mode).toBe("custom");
    expect(next.rows[0].payload).toBe("{}");
    expect(next.rows[1]).toEqual(d.rows[1]); // other rows untouched
  });

  it("reports what a row overrides", () => {
    const d = seed();
    const id = d.rows[0].id;
    expect(rowOverrides(d.rows[0])).toEqual([]);

    expect(rowOverrides(setRowPayloadMode(d, id, "none").rows[0])).toEqual(["payload"]);

    const both = setRowAssertion(setRowPayloadMode(d, id, "custom"), id, "response.status == 400");
    expect(rowOverrides(both.rows[0])).toEqual(["payload", "check"]);

    // Whitespace-only assertion isn't an override.
    expect(rowOverrides(setRowAssertion(d, id, "   ").rows[0])).toEqual([]);
  });

  it("labels rows like the server does", () => {
    const d = seed();
    expect(rowLabel(0, { ...d.rows[0], name: "missing email" })).toBe("missing email");
    expect(rowLabel(1, { ...d.rows[1], name: "   " })).toBe("Row 2");
    expect(rowLabel(2, { ...d.rows[0], name: null })).toBe("Row 3");
  });
});
