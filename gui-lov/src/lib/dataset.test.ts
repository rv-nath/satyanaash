import { describe, it, expect } from "vitest";
import {
  addRow,
  duplicateRow,
  emptyDataset,
  isEmptyDataset,
  looksLikeInvalidJson,
  removeRow,
  rowLabel,
  setRowBody,
  setRowExpectedStatus,
  setRowName,
} from "@/lib/dataset";
import type { Dataset } from "@/lib/api/types";

function seed(): Dataset {
  let d = addRow(addRow(emptyDataset()));
  d = setRowName(d, d.rows[0].id, "valid");
  d = setRowBody(d, d.rows[0].id, '{"email":"a@b.com"}');
  d = setRowExpectedStatus(d, d.rows[0].id, "201");
  return d;
}

describe("dataset reducers", () => {
  it("starts empty", () => {
    expect(isEmptyDataset(emptyDataset())).toBe(true);
    expect(isEmptyDataset(seed())).toBe(false);
  });

  it("adds blank cases", () => {
    const d = addRow(emptyDataset());
    expect(d.rows).toHaveLength(1);
    expect(d.rows[0].body).toBe("");
    expect(d.rows[0].expected_status).toBe("");
    expect(d.rows[0].id).toBeTruthy();
  });

  it("edits a case without touching the others", () => {
    const d = seed();
    const id = d.rows[0].id;
    let next = setRowName(d, id, "renamed");
    next = setRowBody(next, id, "{}");
    next = setRowExpectedStatus(next, id, "400");

    expect(next.rows[0]).toMatchObject({ name: "renamed", body: "{}", expected_status: "400" });
    expect(next.rows[1]).toEqual(d.rows[1]);
  });

  it("removes a case by id", () => {
    const d = seed();
    const gone = d.rows[0].id;
    expect(removeRow(d, gone).rows.find((r) => r.id === gone)).toBeUndefined();
  });

  it("duplicates a case right after the original, with a fresh id", () => {
    const d = seed();
    const next = duplicateRow(d, d.rows[0].id);

    expect(next.rows).toHaveLength(3);
    expect(next.rows[1].name).toBe("valid");
    expect(next.rows[1].body).toBe('{"email":"a@b.com"}');
    expect(next.rows[1].id).not.toBe(d.rows[0].id);
  });

  it("flags a body that looks like broken JSON, but allows non-JSON", () => {
    // A hint, never a block — a malformed body is a legitimate test input.
    expect(looksLikeInvalidJson('{"a":1}')).toBe(false);
    expect(looksLikeInvalidJson('{"a":1')).toBe(true);
    expect(looksLikeInvalidJson("[1,2")).toBe(true);
    expect(looksLikeInvalidJson("")).toBe(false);
    expect(looksLikeInvalidJson("name=value")).toBe(false); // form data
  });

  it("labels rows like the server does", () => {
    const d = seed();
    expect(rowLabel(0, d.rows[0])).toBe("valid");
    expect(rowLabel(1, { ...d.rows[1], name: "  " })).toBe("Row 2");
    expect(rowLabel(2, { ...d.rows[1], name: null })).toBe("Row 3");
  });
});
