import { describe, it, expect } from "vitest";
import {
  addRow,
  duplicateRow,
  emptyDataset,
  isEmptyDataset,
  joinEndpoint,
  looksLikeInvalidJson,
  oneLine,
  removeRow,
  rowLabel,
  setRowBody,
  setRowCheck,
  isStatusShorthand,
  setRowName,
} from "@/lib/dataset";
import type { Dataset } from "@/lib/api/types";

function seed(): Dataset {
  let d = addRow(addRow(emptyDataset()));
  d = setRowName(d, d.rows[0].id, "valid");
  d = setRowBody(d, d.rows[0].id, '{"email":"a@b.com"}');
  d = setRowCheck(d, d.rows[0].id, "201");
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
    expect(d.rows[0].check).toBe("");
    expect(d.rows[0].id).toBeTruthy();
  });

  it("edits a case without touching the others", () => {
    const d = seed();
    const id = d.rows[0].id;
    let next = setRowName(d, id, "renamed");
    next = setRowBody(next, id, "{}");
    next = setRowCheck(next, id, "400");

    expect(next.rows[0]).toMatchObject({ name: "renamed", body: "{}", check: "400" });
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

  it("tells a status shorthand from an expression", () => {
    // Mirrors the server: a check that is nothing but digits is a status check.
    expect(isStatusShorthand("400")).toBe(true);
    expect(isStatusShorthand(" 201 ")).toBe(true);
    expect(isStatusShorthand("response.status == 201")).toBe(false);
    expect(isStatusShorthand("2xx")).toBe(false);
    expect(isStatusShorthand("")).toBe(false);
  });

  it("previews a cell on one line", () => {
    // Minified, so a pretty-printed body isn't previewed as a lone brace.
    expect(oneLine('{\n  "email": "a@b.com"\n}')).toBe('{"email":"a@b.com"}');
    // Interpolation inside a string is still valid JSON.
    expect(oneLine('{\n "s": "{{api_secret}}"\n}')).toBe('{"s":"{{api_secret}}"}');
    // Not JSON, or broken JSON: keep the text, lose the line breaks.
    expect(oneLine('{"a":1')).toBe('{"a":1');
    expect(oneLine("response.status == 201\n  && response.json.id != ()")).toBe(
      "response.status == 201 && response.json.id != ()",
    );
    expect(oneLine("   ")).toBe("");
  });

  it("joins a row's suffix onto the endpoint the way the server does", () => {
    // A path segment is simply appended.
    expect(joinEndpoint("http://x/campaigns", "/acme")).toBe("http://x/campaigns/acme");
    expect(joinEndpoint("http://x/campaigns", "?org=acme")).toBe("http://x/campaigns?org=acme");

    // "?limit=10?org=acme" is one broken parameter, not two.
    expect(joinEndpoint("http://x/c?limit=10", "?org=acme")).toBe("http://x/c?limit=10&org=acme");

    // Blank leaves the endpoint alone.
    expect(joinEndpoint("http://x/c", "   ")).toBe("http://x/c");
    expect(joinEndpoint("http://x/c", "")).toBe("http://x/c");
  });

  it("labels rows like the server does", () => {
    const d = seed();
    expect(rowLabel(0, d.rows[0])).toBe("valid");
    expect(rowLabel(1, { ...d.rows[1], name: "  " })).toBe("Row 2");
    expect(rowLabel(2, { ...d.rows[1], name: null })).toBe("Row 3");
  });
});
