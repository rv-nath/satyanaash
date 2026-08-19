import { describe, it, expect } from "vitest";
import {
  allMembers,
  canRun,
  coversEverything,
  isSelected,
  memberCount,
  memberNote,
  runLabel,
  sectionCount,
  sectionState,
  setSection,
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

describe("a whole section at once", () => {
  it("reads all, some or none — the state a two-way toggle cannot express", () => {
    // `some` is the usual state with 35 tests in a project, which is why the header needs three.
    expect(sectionState({ members: [] }, "flow", available)).toBe("none");
    expect(sectionState({ members: [{ kind: "flow", id: "f1" }] }, "flow", available)).toBe("some");
    expect(
      sectionState(
        { members: [{ kind: "flow", id: "f1" }, { kind: "flow", id: "f2" }] },
        "flow",
        available,
      ),
    ).toBe("all");
  });

  it("reads all in everything-mode, because every row is ticked there too", () => {
    expect(sectionState({ members: undefined }, "flow", available)).toBe("all");
  });

  it("reads none for a kind the project has none of, rather than all of nothing", () => {
    expect(sectionState({ members: undefined }, "test", [{ kind: "flow", id: "f1" }])).toBe("none");
  });

  it("counts picked against total, so a header can say 1/2", () => {
    expect(sectionCount({ members: [{ kind: "flow", id: "f1" }] }, "flow", available)).toEqual({
      picked: 1,
      total: 2,
    });
    expect(sectionCount({ members: undefined }, "test", available)).toEqual({ picked: 1, total: 1 });
  });

  it("ticks every member of one kind and leaves the other kind alone", () => {
    const next = setSection({ members: [{ kind: "test", id: "t1" }] }, "flow", true, available);
    expect(next).toEqual([
      { kind: "flow", id: "f1" },
      { kind: "flow", id: "f2" },
      { kind: "test", id: "t1" },
    ]);
  });

  it("puts added members in project order, not click order", () => {
    // The suite runs in this order, so it has to be the order the author reads down the page.
    const next = setSection({ members: [] }, "flow", true, available);
    expect(next.map((m) => m.id)).toEqual(["f1", "f2"]);
  });

  it("unticks a kind without touching the other", () => {
    const next = setSection(
      { members: [{ kind: "flow", id: "f1" }, { kind: "test", id: "t1" }] },
      "flow",
      false,
      available,
    );
    expect(next).toEqual([{ kind: "test", id: "t1" }]);
  });

  it("materialises the full list before unticking in everything-mode", () => {
    // The trap: `members` is null there, so filtering it directly records nothing — and filtering
    // the wrong way round keeps only what you excluded.
    const next = setSection({ members: undefined }, "flow", false, available);
    expect(next).toEqual([{ kind: "test", id: "t1" }]);
  });

  it("ticking every section is an explicit list, not everything-mode", () => {
    // These must stay distinct: everything-mode picks up tomorrow's new flow on its own, an
    // explicit list does not. Collapsing them changes what the suite covers the day one is added.
    let next = setSection({ members: [] }, "flow", true, available);
    next = setSection({ members: next }, "test", true, available);
    expect(next).toEqual(available);
    expect(coversEverything({ members: next })).toBe(false);
  });

  it("is a no-op when the project has none of that kind", () => {
    expect(setSection({ members: [] }, "test", true, [{ kind: "flow", id: "f1" }])).toEqual([]);
  });
});
