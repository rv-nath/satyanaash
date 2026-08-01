import { describe, it, expect } from "vitest";
import {
  countsLine,
  detailsFor,
  formatDuration,
  formatWhen,
  isInFlight,
  nodeTitle,
  runSubtitle,
  verdict,
  verdictIcon,
} from "@/lib/runHistory";

const run = (over: Partial<Parameters<typeof countsLine>[0]> & Record<string, unknown> = {}) => ({
  status: "completed",
  total: 0,
  passed: 0,
  failed: 0,
  errors: 0,
  skipped: 0,
  ...over,
}) as never;

describe("verdict", () => {
  it("does not take 'completed' for 'passed'", () => {
    // The engine's "completed" means the traversal finished, which a run with four
    // failures also does. A list of green "completed" rows hiding failures is exactly the
    // dishonest green this project keeps designing against.
    expect(verdict(run({ status: "completed", failed: 4 }))).toBe("failed");
    expect(verdict(run({ status: "completed" }))).toBe("passed");
  });

  it("ranks an error above a failure", () => {
    expect(verdict(run({ status: "completed", failed: 2, errors: 1 }))).toBe("error");
  });

  it("keeps stopped and running as their own answers", () => {
    // Walking away is not a pass whatever the counts say, and a run still going has no
    // verdict yet.
    expect(verdict(run({ status: "stopped", passed: 6 }))).toBe("stopped");
    expect(verdict(run({ status: "running" }))).toBe("running");
    expect(isInFlight(run({ status: "running" }))).toBe(true);
    expect(isInFlight(run({ status: "completed" }))).toBe(false);
  });

  it("has a mark for every verdict", () => {
    for (const v of ["passed", "failed", "error", "stopped", "running"] as const) {
      expect(verdictIcon(v)).toBeTruthy();
    }
  });
});

describe("countsLine", () => {
  it("counts against what actually ran, and names the skips", () => {
    // "6/10 passed" with no mention of the four skipped members reads as four failures;
    // "6/6 passed" alone reads as complete coverage. Neither is true.
    expect(countsLine(run({ total: 10, passed: 6, skipped: 4 }))).toBe("6/6 passed · 4 skipped");
  });

  it("stays quiet about what didn't happen", () => {
    expect(countsLine(run({ total: 6, passed: 6 }))).toBe("6/6 passed");
  });

  it("lists failures and errors separately", () => {
    expect(countsLine(run({ total: 6, passed: 3, failed: 2, errors: 1 }))).toBe(
      "3/6 passed · 2 failed · 1 errored",
    );
  });

  it("says plainly when nothing ran", () => {
    // "0/0 passed" beside a green tick is a riddle, and a green one would be a lie.
    expect(countsLine(run({ total: 4, skipped: 4 }))).toBe("nothing ran — all 4 skipped");
    expect(countsLine(run({ total: 0 }))).toBe("nothing ran");
  });
});

describe("formatDuration", () => {
  it("scales from a node to a suite", () => {
    expect(formatDuration(340)).toBe("340ms");
    expect(formatDuration(1240)).toBe("1.2s");
    expect(formatDuration(125_000)).toBe("2m 05s");
    expect(formatDuration(null)).toBe("—");
  });
});

describe("formatWhen", () => {
  const now = new Date("2026-08-01T14:30:00Z");

  it("says 'just now' for a run that has only finished", () => {
    expect(formatWhen("2026-08-01T14:29:30Z", now)).toBe("just now");
  });

  it("gives a time for today and a date for anything older", () => {
    expect(formatWhen("2026-08-01T09:15:00Z", now)).toMatch(/\d{2}:\d{2}/);
    expect(formatWhen("2026-07-28T09:15:00Z", now)).toMatch(/Jul/);
  });

  it("hands back an unparseable timestamp rather than 'Invalid Date'", () => {
    expect(formatWhen("not a date", now)).toBe("not a date");
  });
});

describe("rendering a stored result", () => {
  const stored = (over: Record<string, unknown> = {}) =>
    ({
      node_id: "n1",
      status: "passed",
      duration_ms: 40,
      logs: [],
      request: { method: "POST", url: "http://host/sms", headers: {}, body: '{"a":1}' },
      response: { status: 201, headers: {}, body: '{"ok":true}' },
      ...over,
    }) as never;

  it("goes through the console's own renderer, not a second dialect", () => {
    // A run from last Tuesday must read exactly like the one in front of you, so this
    // asserts the labels the console produces rather than any of its own.
    const details = detailsFor(stored());
    expect(details.map((d) => d.label)).toEqual(["Request", "Payload", "Status", "Response"]);
  });

  it("gives a fan-out aggregate the per-row treatment", () => {
    const rows = [
      { ...(stored() as object), row_index: 0, row_label: "valid" },
      { ...(stored({ status: "failed" }) as object), row_index: 2, row_label: "no sender" },
    ];
    const details = detailsFor(stored({ iterations: rows, status: "failed" }));

    // One entry per row — the granularity the history exists for.
    const rowEntries = details.filter((d) => d.note !== undefined);
    expect(rowEntries).toHaveLength(2);
    expect(rowEntries[1].label).toContain("no sender");
    // Row numbers are the dataset position, not the position in the selection.
    expect(rowEntries[1].label).toContain("3");
  });
});

describe("nodeTitle", () => {
  it("prefers the alias, because two nodes can run one test case", () => {
    expect(nodeTitle({ node_label: "Root login", test_case_name: "Login", node_id: "n1" })).toBe(
      "Root login",
    );
    expect(nodeTitle({ test_case_name: "Login", node_id: "n1" })).toBe("Login");
    // A start or end node has neither, and still needs something to show.
    expect(nodeTitle({ node_id: "start" })).toBe("start");
  });
});

describe("runSubtitle", () => {
  it("does not invent a suite for an ad-hoc run", () => {
    // Every press of Run on a flow is stored as a run of one. Calling that "suite" would
    // put a suite in the history that never existed.
    expect(runSubtitle({ suite_id: null, members: [{}] as never })).toBe("single run");
    expect(runSubtitle({ suite_id: "s1", members: [{}, {}] as never })).toBe("suite · 2 members");
    expect(runSubtitle({ suite_id: "s1", members: [{}] as never })).toBe("suite · 1 member");
  });
});
