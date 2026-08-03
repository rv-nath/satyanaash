import { describe, it, expect } from "vitest";
import {
  breadcrumb,
  initiallyExpanded,
  memberHasProblem,
  nodeHasProblem,
  pathKey,
  resultAt,
  rowSummary,
  samePath,
} from "@/lib/runTree";
import type { FlowRun, SuiteRun, TestCaseExecutionResult } from "@/lib/api/types";

const node = (
  id: string,
  status: TestCaseExecutionResult["status"],
  over: Partial<TestCaseExecutionResult> = {},
): TestCaseExecutionResult => ({
  node_id: id,
  test_case_name: id,
  status,
  duration_ms: 40,
  logs: [],
  ...over,
});

const member = (
  name: string,
  status: string,
  results: TestCaseExecutionResult[],
): FlowRun => ({
  id: name,
  suite_run_id: "r",
  ordinal: 0,
  member_kind: "flow",
  flow_id: "f",
  test_case_id: null,
  name,
  status,
  started_at: "2026-08-02T14:32:00.000Z",
  duration_ms: 100,
  error_message: null,
  results,
});

const run = (members: FlowRun[]): SuiteRun => ({
  id: "r",
  project_id: "p",
  suite_id: "s",
  suite_name: "Regression",
  status: "failed",
  started_at: "2026-08-02T14:32:00.000Z",
  completed_at: null,
  duration_ms: 1000,
  total: 0, passed: 0, failed: 0, errors: 0, skipped: 0,
  environment_name: null,
  error_message: null,
  members,
});

describe("what starts open", () => {
  it("opens failures and leaves passes shut", () => {
    // The same rule the dataset markers follow: say something only when there is
    // something to say. A green run of sixteen nodes is a summary you scroll past.
    const r = run([
      member("All fine", "passed", [node("a", "passed")]),
      member("Broken", "failed", [node("b", "passed"), node("c", "failed")]),
    ]);
    const open = initiallyExpanded(r);

    expect(open.has(pathKey({ member: 0 }))).toBe(false);
    expect(open.has(pathKey({ member: 1 }))).toBe(true);
    // …down to the node that failed, but not its passing sibling.
    expect(open.has(pathKey({ member: 1, node: 1 }))).toBe(true);
    expect(open.has(pathKey({ member: 1, node: 0 }))).toBe(false);
  });

  it("opens a member whose rows failed even though the member passed", () => {
    // A fan-out aggregate can be red inside a member the fold called green. Leaving it
    // shut would hide the only failure in the run.
    const fanout = node("send", "passed", {
      iterations: [node("send", "passed"), node("send", "failed")],
    });
    const open = initiallyExpanded(run([member("Outer", "passed", [fanout])]));
    expect(open.has(pathKey({ member: 0 }))).toBe(true);
    expect(open.has(pathKey({ member: 0, node: 0 }))).toBe(true);
  });

  it("opens the member being watched", () => {
    const open = initiallyExpanded(run([member("In flight", "running", [])]));
    expect(open.has(pathKey({ member: 0 }))).toBe(true);
  });

  it("treats an errored member as a problem, not only a failed one", () => {
    expect(memberHasProblem(member("m", "error", []))).toBe(true);
    expect(nodeHasProblem(node("n", "error"))).toBe(true);
    // A skip is neither — it is the absence of a result, not a bad one.
    expect(memberHasProblem(member("m", "skipped", [node("n", "skipped")]))).toBe(false);
  });
});

describe("addressing", () => {
  const r = run([
    member("First", "failed", [
      node("login", "passed"),
      node("send", "failed", {
        iterations: [
          node("send", "passed", { row_index: 0, row_label: "valid" }),
          node("send", "failed", { row_index: 2, row_label: "no sender" }),
        ],
      }),
    ]),
  ]);

  it("finds a node and a row by position", () => {
    // By position, not by id: a node id repeats across members and a row index repeats
    // across nodes, so ids alone cannot address one thing.
    expect(resultAt(r, { member: 0, node: 0 })?.node_id).toBe("login");
    expect(resultAt(r, { member: 0, node: 1, row: 1 })?.row_label).toBe("no sender");
  });

  it("returns nothing when the tree has changed under the selection", () => {
    // A live run grows between renders; a stale path must not resolve to the wrong result.
    expect(resultAt(r, { member: 9, node: 0 })).toBeUndefined();
    expect(resultAt(r, { member: 0, node: 9 })).toBeUndefined();
    expect(resultAt(r, { member: 0, node: 0, row: 3 })).toBeUndefined();
  });

  it("builds a breadcrumb down to the row", () => {
    expect(breadcrumb(r, { member: 0, node: 1, row: 1 })).toEqual([
      "First", "send", "no sender",
    ]);
    expect(breadcrumb(r, { member: 0 })).toEqual(["First"]);
  });

  it("names an unlabelled row by its dataset position, not its position in the list", () => {
    const unlabelled = run([
      member("M", "failed", [
        node("send", "failed", { iterations: [node("send", "failed", { row_index: 6 })] }),
      ]),
    ]);
    expect(breadcrumb(unlabelled, { member: 0, node: 0, row: 0 })).toEqual(["M", "send", "Row 7"]);
  });

  it("makes a key that is safe to put in a CSS attribute selector", () => {
    // The tree scrolls the selected row into view by querying
    // `[data-treepath="${pathKey(selected)}"]`. A key carrying a quote or a bracket would
    // break that selector silently — the scroll would simply stop happening.
    const keys = [
      pathKey({ member: 0 }),
      pathKey({ member: 0, node: 1 }),
      pathKey({ member: 0, node: 1, row: 2 }),
      pathKey({ member: 10, node: 11, row: 12 }),
    ];
    for (const key of keys) expect(key).toMatch(/^[0-9:]*$/);
    // …and distinct, or the query would scroll to the wrong row.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps a member, its first step and that step's first row apart", () => {
    // All three are "position 0" at their own level, and a key that collapsed them would
    // highlight a member when a row was picked.
    const keys = [
      pathKey({ member: 0 }),
      pathKey({ member: 0, node: 0 }),
      pathKey({ member: 0, node: 0, row: 0 }),
    ];
    expect(new Set(keys).size).toBe(3);
  });

  it("compares paths without caring about object identity", () => {
    expect(samePath({ member: 0, node: 1 }, { member: 0, node: 1 })).toBe(true);
    expect(samePath({ member: 0, node: 1 }, { member: 0, node: 2 })).toBe(false);
    expect(samePath(null, null)).toBe(true);
    expect(samePath(null, { member: 0 })).toBe(false);
    // A node and its first row are different things.
    expect(samePath({ member: 0, node: 1 }, { member: 0, node: 1, row: 0 })).toBe(false);
  });
});

describe("rowSummary", () => {
  it("says nothing for a node that ran once", () => {
    expect(rowSummary(node("a", "passed"))).toBeUndefined();
  });

  it("counts against what ran and names the skips", () => {
    const fanout = node("send", "failed", {
      iterations: [
        node("send", "passed"),
        node("send", "failed"),
        node("send", "skipped"),
      ],
    });
    expect(rowSummary(fanout)).toBe("1/2 rows · 1 skipped");
  });

  it("says plainly when no row ran", () => {
    // "0/0 rows" is a riddle, and a bare "3 rows" beside a green tick is a lie.
    const parked = node("send", "skipped", {
      iterations: [node("send", "skipped"), node("send", "skipped")],
    });
    expect(rowSummary(parked)).toBe("2 rows, none ran");
  });
});
