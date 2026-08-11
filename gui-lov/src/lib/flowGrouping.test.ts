import { describe, it, expect } from "vitest";
import { UNGROUPED, bucketsOf, collapseKey, dropTarget } from "@/lib/flowGrouping";

const flow = (id: string, groupId?: string | null) => ({ id, groupId });
const groups = [
  { id: "g2", name: "Campaigns" },
  { id: "g1", name: "Signup" },
];

describe("arranging flows into buckets", () => {
  it("keeps the groups in the order given, then Ungrouped last", () => {
    // The API returns newest-first; the sidebar must not re-sort it, or a group you just made
    // appears somewhere in the middle.
    const out = bucketsOf([flow("f1", "g1"), flow("f2", "g2"), flow("f3")], groups);
    expect(out.map((b) => b.name)).toEqual(["Campaigns", "Signup", "Ungrouped"]);
    expect(out[0].flows.map((f) => f.id)).toEqual(["f2"]);
    expect(out[2].virtual).toBe(true);
  });

  it("still draws an empty group you just created", () => {
    // A bucket that vanishes until something is in it gives you nowhere to drop the first flow.
    const out = bucketsOf([flow("f1")], groups);
    expect(out.find((b) => b.id === "g1")?.flows).toEqual([]);
    expect(out.map((b) => b.id)).toContain("g1");
  });

  it("hides Ungrouped when nothing is in it", () => {
    // "Ungrouped (0)" is a heading about nothing.
    const out = bucketsOf([flow("f1", "g1")], groups);
    expect(out.some((b) => b.id === UNGROUPED)).toBe(false);
  });

  it("shows a flow whose group no longer exists rather than losing it", () => {
    // The server nulls group_id on delete, but a flow moved in another tab can arrive stale.
    // A flow you cannot see is worse than one in the wrong bucket.
    const out = bucketsOf([flow("f1", "deleted-group")], groups);
    expect(out.find((b) => b.id === UNGROUPED)?.flows.map((f) => f.id)).toEqual(["f1"]);
  });

  it("treats null and absent the same", () => {
    const out = bucketsOf([flow("f1", null), flow("f2")], groups);
    expect(out.find((b) => b.id === UNGROUPED)?.flows).toHaveLength(2);
  });

  it("copes with no groups at all", () => {
    const out = bucketsOf([flow("f1")], []);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(UNGROUPED);
  });
});

describe("what a drop means", () => {
  it("moves a flow into a real group", () => {
    expect(dropTarget("g1", null)).toBe("g1");
    expect(dropTarget("g1", "g2")).toBe("g1");
  });

  it("moves a flow out of every group when dropped on Ungrouped", () => {
    // A real move, unlike the tests rail where dropping on Ungrouped does nothing.
    expect(dropTarget(UNGROUPED, "g1")).toBeNull();
  });

  it("says nothing to do when the flow is already there", () => {
    // So a drop that lands where it started never hits the network.
    expect(dropTarget("g1", "g1")).toBeUndefined();
    expect(dropTarget(UNGROUPED, null)).toBeUndefined();
    expect(dropTarget(UNGROUPED, undefined)).toBeUndefined();
  });
});

describe("remembering which buckets are collapsed", () => {
  it("keys by project, so two projects do not share", () => {
    expect(collapseKey("p1")).not.toBe(collapseKey("p2"));
    expect(collapseKey("p1")).toContain("p1");
  });

  it("has a key even before a project is known", () => {
    expect(collapseKey(undefined)).toBe("sat.flowGroups.collapsed.none");
  });
});
