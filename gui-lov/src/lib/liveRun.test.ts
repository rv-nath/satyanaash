import { describe, it, expect } from "vitest";
import {
  addResult,
  beginLiveRun,
  completeMember,
  completeRun,
  liveRunToSuiteRun,
  progressLine,
  startMember,
  type LiveRun,
} from "@/lib/liveRun";
import type { SuiteRun, TestCaseExecutionResult } from "@/lib/api/types";

const STARTED = "2026-08-02T14:32:00.000Z";

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

/** The stream for a two-member suite, played in the order the server sends it. */
function playToCompletion(): LiveRun {
  let run = beginLiveRun({
    runId: "run-1",
    suiteId: "s1",
    suiteName: "Regression",
    totalMembers: 2,
    startedAt: STARTED,
  });

  run = startMember(run, { kind: "flow", memberId: "f1", name: "Pause campaign Tests" });
  run = addResult(run, node("login", "passed"));
  run = addResult(run, node("pause", "failed"));
  run = completeMember(run, 0, "failed", 1240);

  run = startMember(run, { kind: "test", memberId: "t1", name: "SignUp API" });
  run = addResult(run, node("direct", "passed"));
  run = completeMember(run, 1, "passed", 300);

  return completeRun(run, "failed");
}

/** What the server would hand back for the same run, once stored. */
const stored: SuiteRun = {
  id: "run-1",
  project_id: "",
  suite_id: "s1",
  suite_name: "Regression",
  status: "failed",
  started_at: STARTED,
  completed_at: null,
  duration_ms: null,
  total: 3,
  passed: 2,
  failed: 1,
  errors: 0,
  skipped: 0,
  environment_name: null,
  error_message: null,
  members: [
    {
      id: "run-1:0",
      suite_run_id: "run-1",
      ordinal: 0,
      member_kind: "flow",
      flow_id: "f1",
      test_case_id: null,
      name: "Pause campaign Tests",
      status: "failed",
      started_at: STARTED,
      duration_ms: 1240,
      error_message: null,
      results: [node("login", "passed"), node("pause", "failed")],
    },
    {
      id: "run-1:1",
      suite_run_id: "run-1",
      ordinal: 1,
      member_kind: "test",
      flow_id: null,
      test_case_id: "t1",
      name: "SignUp API",
      status: "passed",
      started_at: STARTED,
      duration_ms: 300,
      error_message: null,
      results: [node("direct", "passed")],
    },
  ],
};

describe("one shape, two sources", () => {
  it("a finished live run is indistinguishable from the stored one", () => {
    // The claim the whole design rests on. If these drift, a run changes appearance the
    // moment its last member completes — which reads as the report reloading wrong.
    expect(liveRunToSuiteRun(playToCompletion())).toEqual(stored);
  });

  it("counts nodes, not rows — the rule the server follows", () => {
    let run = beginLiveRun({ runId: "r", suiteName: "S", totalMembers: 1, startedAt: STARTED });
    run = startMember(run, { kind: "test", memberId: "t1", name: "JT1 · SMS" });
    run = addResult(
      run,
      node("fanout", "failed", {
        iterations: [node("fanout", "passed"), node("fanout", "failed"), node("fanout", "skipped")],
      }),
    );

    const asSuite = liveRunToSuiteRun(run);
    // One fan-out node contributes one failure, not three results.
    expect(asSuite.total).toBe(1);
    expect(asSuite.failed).toBe(1);
    // …and its rows travel with it, as they do from the database.
    expect(asSuite.members[0].results[0].iterations).toHaveLength(3);
  });
});

describe("a run still going", () => {
  it("reports itself as running rather than as a verdict", () => {
    let run = beginLiveRun({ runId: "r", suiteName: "S", totalMembers: 3, startedAt: STARTED });
    run = startMember(run, { kind: "flow", memberId: "f1", name: "First" });
    run = addResult(run, node("a", "passed"));

    const asSuite = liveRunToSuiteRun(run);
    expect(asSuite.status).toBe("running");
    // A member with no verdict yet must not read as passed.
    expect(asSuite.members[0].status).toBe("running");
    expect(asSuite.members[0].duration_ms).toBeNull();
  });

  it("does not present a partial duration as the run's duration", () => {
    // A number that will grow, shown where a final one goes, is worse than no number.
    let run = beginLiveRun({ runId: "r", suiteName: "S", totalMembers: 2, startedAt: STARTED });
    run = startMember(run, { kind: "flow", memberId: "f1", name: "First" });
    run = completeMember(run, 0, "passed", 800);
    expect(liveRunToSuiteRun(run).duration_ms).toBeNull();
  });

  it("shows only what has actually happened", () => {
    // Two of six members done must not render as six rows, four of them blank: an empty
    // row is indistinguishable from one that ran and did nothing.
    let run = beginLiveRun({ runId: "r", suiteName: "S", totalMembers: 6, startedAt: STARTED });
    run = startMember(run, { kind: "flow", memberId: "f1", name: "First" });
    run = completeMember(run, 0, "passed", 100);
    run = startMember(run, { kind: "flow", memberId: "f2", name: "Second" });

    expect(liveRunToSuiteRun(run).members).toHaveLength(2);
  });
});

describe("filing node results", () => {
  it("puts them under the member that is running", () => {
    // Node events carry no member id — the engine does not know it is in a suite — so
    // they belong to the last member started. Getting this wrong silently attributes one
    // flow's failures to another.
    let run = beginLiveRun({ runId: "r", suiteName: "S", totalMembers: 2, startedAt: STARTED });
    run = startMember(run, { kind: "flow", memberId: "f1", name: "First" });
    run = addResult(run, node("a", "passed"));
    run = startMember(run, { kind: "flow", memberId: "f2", name: "Second" });
    run = addResult(run, node("b", "failed"));

    const asSuite = liveRunToSuiteRun(run);
    expect(asSuite.members[0].results.map((r) => r.node_id)).toEqual(["a"]);
    expect(asSuite.members[1].results.map((r) => r.node_id)).toEqual(["b"]);
  });

  it("drops a result that arrives before any member rather than inventing one", () => {
    const run = beginLiveRun({ runId: "r", suiteName: "S", totalMembers: 1, startedAt: STARTED });
    expect(addResult(run, node("orphan", "passed")).members).toEqual([]);
  });
});

describe("progressLine", () => {
  it("names the member being worked on", () => {
    let run = beginLiveRun({ runId: "r", suiteName: "S", totalMembers: 6, startedAt: STARTED });
    run = startMember(run, { kind: "flow", memberId: "f1", name: "Launch a campaign" });
    expect(progressLine(run)).toBe("member 1 of 6 — Launch a campaign");
  });

  it("says how many ran once it is over", () => {
    let run = beginLiveRun({ runId: "r", suiteName: "S", totalMembers: 2, startedAt: STARTED });
    run = startMember(run, { kind: "flow", memberId: "f1", name: "First" });
    run = completeMember(run, 0, "passed", 10);
    run = completeRun(run, "completed");
    expect(progressLine(run)).toBe("1 of 2 members");
  });
});
