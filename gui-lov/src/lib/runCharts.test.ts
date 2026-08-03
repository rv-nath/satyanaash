import { describe, it, expect } from "vitest";
import {
  arcPath,
  CHART_FILL,
  focusPath,
  levelAt,
  memberSeries,
  RUN,
  ran,
  rowCounts,
  runCounts,
  rowsNote,
  slowestSteps,
  sunburstArcs,
  tally,
  total,
  verdictOf,
  VERDICTS,
} from "@/lib/runCharts";
import type { FlowRun, SuiteRun, TestCaseExecutionResult } from "@/lib/api/types";

const node = (
  id: string,
  status: string,
  over: Partial<TestCaseExecutionResult> = {},
): TestCaseExecutionResult => ({
  node_id: id,
  test_case_name: id,
  status: status as TestCaseExecutionResult["status"],
  duration_ms: 40,
  logs: [],
  ...over,
});

const member = (
  name: string,
  status: string,
  results: TestCaseExecutionResult[],
  over: Partial<FlowRun> = {},
): FlowRun => ({
  id: name,
  suite_run_id: "r",
  ordinal: 0,
  member_kind: "flow",
  flow_id: "f",
  test_case_id: null,
  name,
  status,
  started_at: "2026-08-02T12:33:00.000Z",
  duration_ms: 1000,
  error_message: null,
  results,
  ...over,
});

const run = (members: FlowRun[], headline: Partial<SuiteRun> = {}): SuiteRun => ({
  id: "r",
  project_id: "p",
  suite_id: "s",
  suite_name: "Smoking Gun Test",
  status: "failed",
  started_at: "2026-08-02T12:33:00.000Z",
  completed_at: null,
  duration_ms: 120000,
  total: 0, passed: 0, failed: 0, errors: 0, skipped: 0,
  environment_name: null,
  error_message: null,
  members,
  ...headline,
});

/**
 * The shape of the real run this was designed against: flows that pass, standalone tests
 * that fail instantly, one empty member, and a fan-out whose rows are mostly skipped.
 */
const realish = run(
  [
    member("Pause campaign Tests", "completed", [
      node("Login", "passed"),
      node("Reset Password", "passed", { duration_ms: 10834 }),
    ]),
    member("Flow 1", "completed", []),
    member("JT1 - SMS", "failed", [
      node("Send SMS", "failed", {
        duration_ms: 69,
        iterations: [
          node("Send SMS", "passed", { row_index: 0, row_label: "valid", duration_ms: 40 }),
          node("Send SMS", "failed", { row_index: 1, row_label: "no sender", duration_ms: 29 }),
          node("Send SMS", "skipped", { row_index: 2, row_label: "needs a flow", duration_ms: 0 }),
          node("Send SMS", "skipped", { row_index: 3, row_label: "parked", duration_ms: 0 }),
        ],
      }),
    ]),
    member("Balance Enquiry", "failed", [node("Balance Enquiry", "failed", { duration_ms: 27 })]),
  ],
  // What the server stored: nodes only. 4 nodes, 2 passed, 2 failed, 0 skipped.
  { total: 4, passed: 2, failed: 2, errors: 0, skipped: 0 },
);

describe("the chart and the footer count the same things", () => {
  it("memberSeries counts nodes, and its totals equal the stored headline", () => {
    // The trap this exists to stop: the run holds 4 nodes and 4 rows. Counting leaves
    // would show 5 passed beside a footer saying 2, and neither number would be trusted.
    const bars = memberSeries(realish);
    const summed = bars.reduce(
      (acc, b) => ({
        passed: acc.passed + b.passed,
        failed: acc.failed + b.failed,
        errored: acc.errored + b.errored,
        skipped: acc.skipped + b.skipped,
      }),
      { passed: 0, failed: 0, errored: 0, skipped: 0 },
    );

    expect(summed.passed).toBe(realish.passed);
    expect(summed.failed).toBe(realish.failed);
    expect(summed.skipped).toBe(realish.skipped);
    expect(total(summed)).toBe(realish.total);
  });

  it("reports a member's rows without adding them to its segments", () => {
    const smss = memberSeries(realish).find((b) => b.name === "JT1 - SMS")!;
    expect(total(smss)).toBe(1); // one node
    expect(smss.rows).toBe(4); // four rows, stated separately
  });

  it("keeps node counts and row counts as separate answers", () => {
    // The headline says 0 skipped. Two rows were skipped. Both are true of different
    // units, and this is the pair of functions that lets the UI say so.
    expect(runCounts(realish).skipped).toBe(0);
    expect(rowCounts(realish).skipped).toBe(2);
  });
});

describe("rowsNote", () => {
  it("says what the headline leaves out", () => {
    // countsLine reads "2/4 passed · 2 failed" and never mentions the two skipped rows.
    // Green by omission, and the reason this sentence exists.
    expect(rowsNote(realish)).toBe("2 of 4 rows skipped");
  });

  it("says nothing when there is nothing to add", () => {
    // Never pads a run with no rows, or a run whose rows all ran.
    expect(rowsNote(run([member("m", "passed", [node("a", "passed")])]))).toBe("");
    expect(
      rowsNote(
        run([
          member("m", "passed", [
            node("a", "passed", { iterations: [node("a", "passed"), node("a", "failed")] }),
          ]),
        ]),
      ),
    ).toBe("");
  });
});

describe("a member that ran nothing", () => {
  it("is flagged rather than left as an empty bar", () => {
    // `Flow 1` is green, 0 ms, no steps. Sized by count it vanishes, which is how the
    // current view hides it.
    const flow1 = memberSeries(realish).find((b) => b.name === "Flow 1")!;
    expect(flow1.empty).toBe(true);
    expect(total(flow1)).toBe(0);
  });

  it("still gets a slice once you drill to its verdict", () => {
    const slice = levelAt(realish, { kind: "verdict", verdict: "skipped" }).slices.find(
      (s) => s.label === "Flow 1",
    )!;
    expect(slice.value).toBeGreaterThan(0);
    expect(slice.note).toBe("nothing ran");
  });

  it("still gets an arc in the sunburst", () => {
    const arc = sunburstArcs(realish).find((a) => a.label === "Flow 1")!;
    expect(arc.endAngle - arc.startAngle).toBeGreaterThan(0);
  });
});

describe("levelAt — one navigation model for every view", () => {
  it("leads with the verdict, not a wall of members", () => {
    // Seventeen bars make you read every label to find the point. "2 passed, 2 failed"
    // is the point, and the members are the answer to a follow-up question.
    const level = levelAt(realish, RUN);
    expect(level.unit).toBe("verdicts");
    expect(level.slices.map((s) => s.label)).toEqual(["passed", "failed"]);
    expect(level.slices.map((s) => s.value)).toEqual([2, 2]);
  });

  it("leaves out a verdict that did not happen", () => {
    // A zero-width "0 errored" segment is noise; the totals row already says zero.
    expect(levelAt(realish, RUN).slices.map((s) => s.label)).not.toContain("errored");
  });

  it("drills a verdict to the members that caused it", () => {
    const level = levelAt(realish, { kind: "verdict", verdict: "failed" });
    expect(level.unit).toBe("members");
    expect(level.slices.map((s) => s.label)).toEqual(["JT1 - SMS", "Balance Enquiry"]);
    // …and says how much of each member it was.
    expect(level.slices[0].note).toBe("1 of 1");
  });

  it("keeps a member that ran nothing visible under its own verdict", () => {
    // `Flow 1` contributes no verdict of its own. Dropping it is how the current view
    // loses it entirely.
    const level = levelAt(realish, { kind: "verdict", verdict: "skipped" });
    const flow1 = level.slices.find((s) => s.label === "Flow 1");
    expect(flow1?.note).toBe("nothing ran");
  });

  it("drills a member to its steps", () => {
    const level = levelAt(realish, { kind: "member", member: 0 });
    expect(level.unit).toBe("steps");
    expect(level.slices.map((s) => s.label)).toEqual(["Login", "Reset Password"]);
  });

  it("drills a fan-out step to its rows, and the unit changes with it", () => {
    // At this level the two skips finally appear, where the headline said zero.
    const level = levelAt(realish, { kind: "node", member: 2, node: 0 });
    expect(level.unit).toBe("rows");
    expect(level.slices.map((s) => s.label)).toEqual([
      "valid", "no sender", "needs a flow", "parked",
    ]);
    expect(level.counts.skipped).toBe(2);
  });

  it("offers no way further in from a leaf", () => {
    const rows = levelAt(realish, { kind: "node", member: 2, node: 0 }).slices;
    expect(rows.every((s) => s.next === undefined)).toBe(true);
    // …and a step carrying rows does offer one.
    const steps = levelAt(realish, { kind: "member", member: 2 }).slices;
    expect(steps[0].next).toEqual({ kind: "node", member: 2, node: 0 });
  });

  it("summarises a fan-out step without opening it", () => {
    const step = levelAt(realish, { kind: "member", member: 2 }).slices[0];
    expect(step.note).toBe("1/2 rows · 2 skipped");
  });

  it("builds a breadcrumb you can climb back out of", () => {
    const level = levelAt(realish, { kind: "node", member: 2, node: 0 });
    expect(level.crumbs.map((c) => c.label)).toEqual(["Run", "JT1 - SMS", "Send SMS"]);
    expect(level.crumbs[0].focus).toEqual(RUN);
  });

  it("carries a tree path everywhere one exists, and nowhere it does not", () => {
    // A verdict is not a place in the run, so it selects nothing.
    expect(levelAt(realish, RUN).slices.every((s) => s.path === undefined)).toBe(true);
    expect(levelAt(realish, { kind: "member", member: 0 }).slices[0].path).toEqual({
      member: 0, node: 0,
    });
    expect(focusPath({ kind: "node", member: 1, node: 2 })).toEqual({ member: 1, node: 2 });
    expect(focusPath(RUN)).toBeNull();
  });

  it("survives a focus that no longer resolves", () => {
    // A live run grows between renders; a stale focus must not throw.
    expect(levelAt(realish, { kind: "member", member: 99 }).slices).toEqual([]);
  });
});

describe("slices must be addressed by position, not by value", () => {
  it("gives several members the same count and different notes", () => {
    // The bug this guards is in the label renderer, but it is only reachable because the
    // data allows it: at member level a dozen slices share the value 1, so looking a slice
    // up *by value* — as Recharts' label.formatter forces you to — puts the first one's
    // note on all of them. The renderer uses the index instead; this pins the premise.
    const many = run([
      member("A", "failed", [node("a", "failed")]),
      member("B", "failed", [node("b", "failed")]),
      member("C", "failed", [node("c", "failed")]),
    ]);
    const slices = levelAt(many, { kind: "verdict", verdict: "failed" }).slices;

    expect(slices.map((s) => s.value)).toEqual([1, 1, 1]);
    expect(slices.map((s) => s.label)).toEqual(["A", "B", "C"]);
    // Distinct positions, identical values — so position is the only identity available.
    expect(new Set(slices.map((s) => s.value)).size).toBe(1);
  });
});

describe("slowestSteps", () => {
  it("names the member each step came from", () => {
    // Four `Reset Password` bars are meaningless without it.
    const steps = slowestSteps(realish);
    expect(steps[0]).toMatchObject({ label: "Reset Password", member: "Pause campaign Tests" });
  });

  it("ranks by duration, longest first", () => {
    const ms = slowestSteps(realish).map((s) => s.ms);
    expect(ms).toEqual([...ms].sort((a, b) => b - a));
  });

  it("lists a fan-out's rows rather than the node, so time is not double counted", () => {
    const labels = slowestSteps(realish).map((s) => s.label);
    expect(labels).toContain("Send SMS · valid");
    expect(labels).not.toContain("Send SMS");
  });

  it("leaves out steps that took no time", () => {
    // A skipped step sent no request. Ranking it at 0 ms would push real measurements off
    // the chart.
    expect(slowestSteps(realish).every((s) => s.ms > 0)).toBe(true);
    expect(slowestSteps(realish).map((s) => s.label)).not.toContain("Send SMS · parked");
  });

  it("honours the limit", () => {
    expect(slowestSteps(realish, 2)).toHaveLength(2);
  });
});

describe("sunburstArcs", () => {
  const arcs = sunburstArcs(realish);

  it("fills exactly one turn at the member ring", () => {
    const ring0 = arcs.filter((a) => a.ring === 0);
    const covered = ring0.reduce((sum, a) => sum + (a.endAngle - a.startAngle), 0);
    expect(covered).toBeCloseTo(360, 6);
  });

  it("nests nodes inside their member's span", () => {
    const parent = arcs.find((a) => a.ring === 0 && a.label === "Pause campaign Tests")!;
    const children = arcs.filter((a) => a.ring === 1 && a.path.member === parent.path.member);
    expect(children.length).toBe(2);
    for (const child of children) {
      expect(child.startAngle).toBeGreaterThanOrEqual(parent.startAngle - 1e-9);
      expect(child.endAngle).toBeLessThanOrEqual(parent.endAngle + 1e-9);
    }
    // …and together they fill it.
    const covered = children.reduce((sum, a) => sum + (a.endAngle - a.startAngle), 0);
    expect(covered).toBeCloseTo(parent.endAngle - parent.startAngle, 6);
  });

  it("nests rows inside their node's span", () => {
    const node0 = arcs.find((a) => a.ring === 1 && a.label === "Send SMS")!;
    const rows = arcs.filter((a) => a.ring === 2);
    expect(rows).toHaveLength(4);
    const covered = rows.reduce((sum, a) => sum + (a.endAngle - a.startAngle), 0);
    expect(covered).toBeCloseTo(node0.endAngle - node0.startAngle, 6);
  });

  it("gives a heavy member more of the circle than a light one", () => {
    const sms = arcs.find((a) => a.ring === 0 && a.label === "JT1 - SMS")!;
    const balance = arcs.find((a) => a.ring === 0 && a.label === "Balance Enquiry")!;
    expect(sms.endAngle - sms.startAngle).toBeGreaterThan(balance.endAngle - balance.startAngle);
  });

  it("says nothing about an empty run rather than dividing by zero", () => {
    expect(sunburstArcs(run([]))).toEqual([]);
  });
});

describe("arcPath", () => {
  it("draws a closed band", () => {
    const d = arcPath({ startAngle: 0, endAngle: 90 }, 40, 60);
    expect(d.startsWith("M ")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d).toContain("A 60 60");
    expect(d).toContain("A 40 40");
  });

  it("splits a full turn into two arcs", () => {
    // One arc from 0° to 360° collapses: the start and end points coincide and nothing is
    // drawn. A single-member run is exactly this case.
    const d = arcPath({ startAngle: 0, endAngle: 360 }, 40, 60);
    expect(d.match(/A 60 60/g)).toHaveLength(2);
    expect(d.match(/A 40 40/g)).toHaveLength(2);
  });

  it("sets the large-arc flag past a half turn", () => {
    expect(arcPath({ startAngle: 0, endAngle: 200 }, 40, 60)).toContain("A 60 60 0 1 1");
    expect(arcPath({ startAngle: 0, endAngle: 100 }, 40, 60)).toContain("A 60 60 0 0 1");
  });

  it("starts at twelve o'clock", () => {
    // A ring that starts at three o'clock reads as rotated and makes the first member
    // hard to find. Parsed rather than pattern-matched: the y is exact, the x is
    // cos(90°) and lands on 0 only because the output is rounded.
    const [x, y] = arcPath({ startAngle: 0, endAngle: 90 }, 40, 60, 0, 0)
      .slice(2)
      .split(' ')
      .slice(0, 2)
      .map(Number);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(-60, 6);
  });

  it("emits no floating-point noise", () => {
    // Unrounded, cos(90°) reaches the DOM as "3.67394039744206e-15".
    expect(arcPath({ startAngle: 0, endAngle: 90 }, 40, 60)).not.toContain('e-');
  });
});

describe("verdicts", () => {
  it("maps the engine's words, including its 'error' spelling", () => {
    expect(verdictOf("passed")).toBe("passed");
    expect(verdictOf("failed")).toBe("failed");
    expect(verdictOf("error")).toBe("errored");
    expect(verdictOf("skipped")).toBe("skipped");
    // Anything unrecognised is not silently a pass.
    expect(verdictOf("running")).toBe("skipped");
  });

  it("keeps skips out of the denominator that 'passed' is measured against", () => {
    const counts = tally([node("a", "passed"), node("b", "skipped"), node("c", "failed")]);
    expect(total(counts)).toBe(3);
    expect(ran(counts)).toBe(2);
  });

  it("has a fill for every verdict", () => {
    for (const v of VERDICTS) expect(CHART_FILL[v]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("keeps passed and failed far apart, which the app's own colours do not", () => {
    // Documented here so a future tidy-up that "restores the theme colours" has to argue
    // with a test. #25934d vs #d32222 is ΔE 5.2 under deuteranopia — indistinguishable.
    expect(CHART_FILL.passed).toBe("#4fb477");
    expect(CHART_FILL.failed).toBe("#a11212");
  });
});
