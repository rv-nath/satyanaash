import { describe, it, expect } from "vitest";
import {
  allMembers,
  canRun,
  coversEverything,
  isSelected,
  memberCount,
  memberNote,
  runLabel,
  toggleMember,
} from "@/lib/suites";
import type { Flow, SuiteMember, TestCase } from "@/lib/api/types";

const flow = (id: string): Flow => ({ id, name: id }) as Flow;
const test = (id: string): TestCase => ({ id, name: id }) as TestCase;

const available: SuiteMember[] = [
  { kind: "flow", id: "f1" },
  { kind: "flow", id: "f2" },
  { kind: "test", id: "t1" },
];

describe("absent members versus empty members", () => {
  it("tells the two apart, which everything else rests on", () => {
    // Collapse these and narrowing a suite to nothing silently runs the whole project.
    expect(coversEverything({ members: undefined })).toBe(true);
    expect(coversEverything({ members: [] })).toBe(false);
  });

  it("counts everything when unset, and nothing when empty", () => {
    expect(memberCount({ members: undefined }, available)).toBe(3);
    expect(memberCount({ members: [] }, available)).toBe(0);
  });

  it("ticks every box in everything-mode without listing them", () => {
    const suite = { members: undefined };
    expect(isSelected(suite, "flow", "f2")).toBe(true);
    expect(isSelected(suite, "test", "t1")).toBe(true);
    // Including one added after the suite was saved — that is the point of the mode.
    expect(isSelected(suite, "flow", "brand-new")).toBe(true);
  });
});

describe("toggleMember", () => {
  it("adds and removes", () => {
    expect(toggleMember({ members: [] }, "flow", "f1", available)).toEqual([
      { kind: "flow", id: "f1" },
    ]);
    expect(
      toggleMember({ members: [{ kind: "flow", id: "f1" }] }, "flow", "f1", available),
    ).toEqual([]);
  });

  it("keeps the project's order, not the order things were ticked", () => {
    // The list is the run order, so it has to read the way the picker reads.
    let members = toggleMember({ members: [] }, "test", "t1", available);
    members = toggleMember({ members }, "flow", "f1", available);
    expect(members).toEqual([
      { kind: "flow", id: "f1" },
      { kind: "test", id: "t1" },
    ]);
  });

  it("materialises the whole list when unticking out of everything-mode", () => {
    // The bug this guards: taking the list as `[]` would record the one excluded member
    // as the only *included* one — a suite that runs exactly what you told it not to.
    const members = toggleMember({ members: undefined }, "flow", "f2", available);
    expect(members).toEqual([
      { kind: "flow", id: "f1" },
      { kind: "test", id: "t1" },
    ]);
    expect(coversEverything({ members })).toBe(false);
  });

  it("distinguishes a flow from a test that happens to share an id", () => {
    const clashing: SuiteMember[] = [
      { kind: "flow", id: "same" },
      { kind: "test", id: "same" },
    ];
    const members = toggleMember({ members: clashing }, "flow", "same", clashing);
    expect(members).toEqual([{ kind: "test", id: "same" }]);
  });
});

describe("the Run button", () => {
  it("says what is selected rather than a bare number", () => {
    expect(runLabel({ members: [{ kind: "flow", id: "f1" }] }, available)).toBe("Run 1");
    expect(runLabel({ members: undefined }, available)).toBe("Run 3");
  });

  it("says nothing is selected rather than 'Run 0'", () => {
    // A new suite is blank, so this is its ordinary state, not an error.
    expect(runLabel({ members: [] }, available)).toBe("Nothing selected");
    expect(canRun({ members: [] }, available)).toBe(false);
    expect(canRun({ members: [{ kind: "flow", id: "f1" }] }, available)).toBe(true);
  });

  it("cannot run an everything-suite in an empty project", () => {
    expect(runLabel({ members: undefined }, [])).toBe("Nothing selected");
    expect(canRun({ members: undefined }, [])).toBe(false);
  });
});

describe("allMembers", () => {
  it("puts flows before tests, which is the run order", () => {
    expect(allMembers([flow("f1")], [test("t1")])).toEqual([
      { kind: "flow", id: "f1" },
      { kind: "test", id: "t1" },
    ]);
  });
});

describe("memberNote", () => {
  const rows = (specs: Array<{ needs_flow?: boolean; disabled?: boolean }>) => ({
    dataset: { rows: specs.map((s, i) => ({ id: `r${i}`, ...s })) },
  });

  it("says nothing about a test with no dataset", () => {
    // There is no row to carry a "needs a flow" flag, so there is nothing to report —
    // the gap that a test-case-level marking would close.
    expect(memberNote({ dataset: undefined })).toBeUndefined();
    expect(memberNote({ dataset: { rows: [] } })).toBeUndefined();
  });

  it("gives a plain count when every row can run", () => {
    expect(memberNote(rows([{}, {}, {}]))).toBe("3 rows");
  });

  it("gives a fraction when some rows cannot", () => {
    expect(memberNote(rows([{}, { needs_flow: true }, { disabled: true }]))).toBe("1 of 3 rows");
  });

  it("warns when the test would be included and then skip everything", () => {
    // Otherwise the suite reports a member that sent nothing and looks no different from
    // one that passed.
    expect(memberNote(rows([{ needs_flow: true }, { needs_flow: true }]))).toBe(
      "no rows can run alone",
    );
  });
});
