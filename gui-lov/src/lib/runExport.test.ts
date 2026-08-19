/**
 * Getting a run out as a sheet.
 *
 * The report on screen answers "how did the run go"; this answers "which of the 123 things went
 * wrong, and what did they say". Those want different shapes, and the second one is a flat table
 * you can filter — which is why this exists rather than a prettier chart.
 */
import { describe, it, expect } from "vitest";
import {
  runRows,
  toCsv,
  exportFileName,
  COLUMNS,
  COLUMN_LABELS,
  type ExportRow,
} from "@/lib/runExport";
import type { SuiteRun, FlowRun, TestCaseExecutionResult } from "@/lib/api/types";

const step = (over: Partial<TestCaseExecutionResult> = {}): TestCaseExecutionResult => ({
  node_id: "n1",
  status: "passed",
  duration_ms: 12,
  logs: [],
  ...over,
});

const member = (over: Partial<FlowRun> = {}): FlowRun => ({
  id: "m1",
  suite_run_id: "r1",
  ordinal: 0,
  member_kind: "flow",
  name: "auth-boundary",
  status: "failed",
  started_at: "2026-08-18T14:32:00Z",
  ...over,
});

const run = (members: FlowRun[], over: Partial<SuiteRun> = {}): SuiteRun => ({
  id: "r1",
  project_id: "p1",
  suite_name: "auth-boundary",
  status: "failed",
  started_at: "2026-08-18T14:32:00Z",
  total: 0,
  passed: 0,
  failed: 0,
  errors: 0,
  skipped: 0,
  members,
  ...over,
});

const cell = (row: Record<string, string>, name: string) => row[name];

describe("runRows — the grain", () => {
  it("gives a plain step one row", () => {
    const rows = runRows(run([member({ results: [step({ test_case_name: "Login" })] })]));
    expect(rows).toHaveLength(1);
    expect(cell(rows[0], "step")).toBe("Login");
  });

  it("gives a fan-out step one row per iteration, and none of its own", () => {
    // The collapse that makes the on-screen headline unreadable: a step with forty rows counts 1
    // towards "123 steps" while its forty verdicts are what you actually need to see. Including the
    // aggregate as well would double-count, because it is a fold of the iterations.
    const rows = runRows(
      run([
        member({
          results: [
            step({
              test_case_name: "Auth boundary",
              status: "failed",
              iterations: [
                step({ status: "failed", row_label: "garbage bearer" }),
                step({ status: "failed", row_label: "expired 1h" }),
              ],
            }),
          ],
        }),
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => cell(r, "case"))).toEqual(["garbage bearer", "expired 1h"]);
  });

  it("leaves the case column blank for a step that is not fanned out", () => {
    const rows = runRows(run([member({ results: [step({ test_case_name: "Login" })] })]));
    expect(cell(rows[0], "case")).toBe("");
  });

  it("prefers the node's alias over the request's name, as every other screen does", () => {
    const rows = runRows(
      run([member({ results: [step({ node_label: "Login as the new user", test_case_name: "Login" })] })]),
    );
    expect(cell(rows[0], "step")).toBe("Login as the new user");
  });

  it("keeps members in order and names each row's member", () => {
    const rows = runRows(
      run([
        member({ name: "auth-boundary", results: [step()] }),
        member({ name: "user-lifecycle", results: [step()] }),
      ]),
    );
    expect(rows.map((r) => cell(r, "member"))).toEqual(["auth-boundary", "user-lifecycle"]);
  });

  it("has nothing to say about a run with no members", () => {
    expect(runRows(run([]))).toEqual([]);
    expect(runRows(run([member({ results: [] })]))).toEqual([]);
  });
});

describe("runRows — the columns", () => {
  it("reports the verdict, what was expected, and what came back", () => {
    const rows = runRows(
      run([
        member({
          results: [
            step({
              status: "failed",
              expected: "401",
              response: { status: 200, headers: {}, body: "{}" },
              request: { method: "GET", url: "http://x/api/v1/accounts/list", headers: {} },
              duration_ms: 412,
            }),
          ],
        }),
      ]),
    );
    expect(cell(rows[0], "verdict")).toBe("failed");
    expect(cell(rows[0], "expected")).toBe("401");
    expect(cell(rows[0], "got")).toBe("200");
    expect(cell(rows[0], "method")).toBe("GET");
    expect(cell(rows[0], "url")).toBe("http://x/api/v1/accounts/list");
    expect(cell(rows[0], "ms")).toBe("412");
  });

  it("leaves `got` blank for a step that sent nothing", () => {
    // For a wait, `response.status` is what *satyanaash* replied — always 200, never a status the
    // caller sent. The console suppresses it for the same reason: "200" beside a delivery report
    // that said FAILED is the one row that must never appear.
    const rows = runRows(
      run([
        member({
          results: [
            step({
              node_label: "Wait for the report",
              status: "failed",
              response: { status: 200, headers: {}, body: '{"status":"FAILED"}' },
              iterations_of: "callback",
            }),
          ],
        }),
      ]),
    );
    expect(cell(rows[0], "got")).toBe("");
    expect(cell(rows[0], "method")).toBe("");
  });

  it("says nothing rather than 1 when a step did not poll", () => {
    const rows = runRows(run([member({ results: [step()] })]));
    expect(cell(rows[0], "attempts")).toBe("");
  });

  it("reports attempts when a step polled", () => {
    const rows = runRows(run([member({ results: [step({ attempts: 3 })] })]));
    expect(cell(rows[0], "attempts")).toBe("3");
  });

  it("marks a teardown step, so cleanup trouble reads as cleanup trouble", () => {
    const rows = runRows(run([member({ results: [step({ teardown: true })] })]));
    expect(cell(rows[0], "teardown")).toBe("teardown");
    const plain = runRows(run([member({ results: [step()] })]));
    expect(cell(plain[0], "teardown")).toBe("");
  });

  it("carries the error message, which is why you opened the file", () => {
    const rows = runRows(
      run([member({ results: [step({ status: "error", error_message: "Cannot read 'groups'" })] })]),
    );
    expect(cell(rows[0], "error")).toBe("Cannot read 'groups'");
  });
});

describe("toCsv", () => {
  const csvOf = (rows: ExportRow[]) => toCsv(rows);

  it("starts with a UTF-8 BOM, or Excel mangles the labels", () => {
    // Real step names carry → and — ("Unusable credentials → /accounts/list"). Without a BOM Excel
    // reads the file as its local codepage and those arrive as mojibake.
    expect(csvOf([])).toMatch(/^﻿/);
  });

  it("writes the header row as labels, in the declared column order", () => {
    const lines = csvOf([]).replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe(COLUMNS.map((c) => COLUMN_LABELS[c]).join(","));
    // The label differs from the key for the first column, which is the whole reason they are
    // now two things: "member" is the API's word and it covers both kinds.
    expect(lines[0]).toContain("flow / test");
    expect(lines[0]).not.toMatch(/(^|,)member(,|$)/);
  });

  it("quotes a value containing a comma, a quote, or a newline", () => {
    const csv = csvOf([
      { ...blank(), error: 'must be one of: PUSH, PULL' },
      { ...blank(), error: 'he said "no"' },
      { ...blank(), error: "line one\nline two" },
    ]);
    expect(csv).toContain('"must be one of: PUSH, PULL"');
    // A quote inside a quoted field is doubled — RFC4180, and what Excel expects.
    expect(csv).toContain('"he said ""no"""');
    expect(csv).toContain('"line one\nline two"');
  });

  it("leaves an ordinary value unquoted, so the file stays readable", () => {
    expect(csvOf([{ ...blank(), verdict: "failed" }])).toContain("failed");
    expect(csvOf([{ ...blank(), verdict: "failed" }])).not.toContain('"failed"');
  });

  it("defuses a value Excel would run as a formula", () => {
    // `expected` can hold a Rhai expression and `error` is server text, so a leading =, +, - or @
    // is reachable. Excel executes those on open.
    for (const dangerous of ["=1+1", "+1", "-1", "@SUM(A1)"]) {
      const csv = csvOf([{ ...blank(), expected: dangerous }]);
      expect(csv).toContain(`'${dangerous}`);
    }
  });

  it("still quotes a defused value that also needs quoting", () => {
    const csv = csvOf([{ ...blank(), expected: '=IF(A1,"a,b")' }]);
    expect(csv).toContain(`"'=IF(A1,""a,b"")"`);
  });

  it("ends every row with CRLF, which is what Excel expects", () => {
    expect(csvOf([{ ...blank(), verdict: "passed" }])).toMatch(/\r\n$/);
  });
});

describe("exportFileName", () => {
  it("names the run and the local minute it started", () => {
    // Local, not UTC, to agree with `formatWhen` in the runs rail: an author who sees 20:02 there
    // must not get a file called ...-1432. Derived from the same instant so the test holds in any
    // timezone while still pinning the format.
    const started = "2026-08-18T14:32:05Z";
    const d = new Date(started);
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
    expect(exportFileName(run([], { suite_name: "auth-boundary", started_at: started })))
      .toBe(`auth-boundary-${stamp}.csv`);
  });

  it("drops a timestamp it cannot read rather than writing NaN into the name", () => {
    expect(exportFileName(run([], { suite_name: "auth-boundary", started_at: "not a date" })))
      .toBe("auth-boundary.csv");
  });

  it("keeps a name with spaces and slashes usable as a filename", () => {
    expect(exportFileName(run([], { suite_name: "Upload numbers / Ent Admin" })))
      .toMatch(/^upload-numbers-ent-admin-/);
  });

  it("falls back rather than producing a nameless file", () => {
    expect(exportFileName(run([], { suite_name: "   " }))).toMatch(/^run-/);
  });
});

/** Every column blank, so a test can set only the one it is about. */
function blank(): ExportRow {
  return Object.fromEntries(COLUMNS.map((c) => [c, ""])) as ExportRow;
}

describe("runRows — which kind of member", () => {
  it("says whether a row came from a flow or a standalone test", () => {
    // Not cosmetic: a real run here holds 13 flows and 33 tests, and the report gave no way to
    // tell them apart — so 33 of 46 outer arcs in the chart were tests read as flows.
    const rows = runRows(
      run([
        member({ name: "auth-boundary", member_kind: "flow", results: [step()] }),
        member({ name: "Balance Enquiry", member_kind: "test", results: [step()] }),
      ]),
    );
    expect(rows.map((r) => cell(r, "kind"))).toEqual(["flow", "test"]);
  });
});
