/**
 * A run as a sheet you can filter.
 *
 * The report on screen answers *how did the run go*. This answers *which of the hundred-odd things
 * went wrong, and what did they say* — and those want different shapes. The screen's headline
 * counts **steps**, so a step with forty data rows contributes 1 to it while its forty verdicts,
 * the ones you need, are folded into a single ✗. No arrangement of that number makes the forty
 * readable; a flat table with one row each does, and Excel's autofilter then does the rest.
 *
 * So the grain here is the **leaf**: a plain step is one row, and a fanned-out step is one row per
 * iteration and none of its own. Including the aggregate too would double-count, since it is a fold
 * of the very rows beside it.
 *
 * Deliberately not xlsx. Triage needs filtering, not formatting, and Excel filters a CSV on
 * Ctrl+Shift+L — which is worth more than styling and costs no dependency. What CSV *does* need is
 * three details that decide whether the file survives Excel at all; they are in `toCsv`.
 */
import type { FlowRun, SuiteRun, TestCaseExecutionResult } from "@/lib/api/types";

/**
 * The columns, in reading order: who ran it, how it went, then the evidence.
 *
 * Exported because the header row, the blank-row helper in the tests, and any future consumer must
 * agree on both the set and the order — a sheet whose columns move between runs cannot be diffed.
 */
export const COLUMNS = [
  "member",
  "kind",
  "step",
  "case",
  "verdict",
  "expected",
  "got",
  "method",
  "url",
  "ms",
  "attempts",
  "teardown",
  "error",
] as const;

export type ExportColumn = (typeof COLUMNS)[number];
export type ExportRow = Record<ExportColumn, string>;

/**
 * What each column is called in a file, separate from the key it is stored under.
 *
 * They were one thing, which meant the header text and the object key could not differ — and the
 * first column needs them to. `member` is the word the API uses for "a thing a suite ran", and it
 * covers two kinds: a real run of this project has **13 flows and 33 tests** in it, so a reader
 * scanning that column is looking at both without being told. `flow / test` says so.
 *
 * `kind` is the same fact made filterable, which is the cut you cannot make by eye when 33 of 46
 * rows are standalone tests.
 */
export const COLUMN_LABELS: Record<ExportColumn, string> = {
  member: "flow / test",
  kind: "kind",
  step: "step",
  case: "case",
  verdict: "verdict",
  expected: "expected",
  got: "got",
  method: "method",
  url: "url",
  ms: "ms",
  attempts: "attempts",
  teardown: "teardown",
  error: "error",
};

/** Column widths for a spreadsheet, so the sheet is readable without dragging anything. */
export const COLUMN_WIDTHS: Record<ExportColumn, number> = {
  member: 26,
  kind: 6,
  step: 30,
  case: 34,
  verdict: 9,
  expected: 16,
  got: 6,
  method: 8,
  url: 52,
  ms: 8,
  attempts: 9,
  teardown: 10,
  error: 60,
};

/** Absent is an empty cell, never the text "undefined". */
const text = (value: string | number | null | undefined): string =>
  value === null || value === undefined ? "" : String(value);

/**
 * One leaf as a row.
 *
 * `got` and `method` come from the response and request, and both are **left blank when the step
 * sent nothing**. That is not tidiness: for an `awaitCallback` step `response.status` is what
 * *satyanaash* replied to the sender — always 200, never a status the caller sent — so a cell
 * reading `200` beside a delivery report that said FAILED would be the one row in the file that
 * lies. The console suppresses it for exactly this reason; `request` being absent is how both know.
 */
function rowOf(member: FlowRun, node: TestCaseExecutionResult, leaf: TestCaseExecutionResult): ExportRow {
  const sent = leaf.request ?? node.request;
  return {
    member: member.name,
    kind: member.member_kind,
    // The alias when the author gave the node one, as every other screen prefers.
    step: text(node.node_label || node.test_case_name || node.node_id),
    case: text(leaf === node ? "" : leaf.row_label),
    verdict: leaf.status,
    expected: text(leaf.expected),
    got: sent ? text(leaf.response?.status) : "",
    method: text(sent?.method),
    url: text(sent?.url),
    ms: text(leaf.duration_ms),
    // Absent rather than "1" on a step that did not poll — one duration cannot tell a slow request
    // from three quick ones and two waits, and "1 attempt" says nothing.
    attempts: text(leaf.attempts),
    teardown: node.teardown ? "teardown" : "",
    error: text(leaf.error_message),
  };
}

/**
 * Every leaf of a run, in run order.
 *
 * Members in the order they ran, their steps in order, and a fanned-out step's iterations in
 * dataset order — so the sheet reads as the run happened and two exports of the same suite line up
 * against each other.
 */
export function runRows(run: SuiteRun): ExportRow[] {
  const rows: ExportRow[] = [];
  for (const member of run.members ?? []) {
    for (const node of member.results ?? []) {
      const iterations = node.iterations ?? [];
      if (iterations.length > 0) {
        for (const leaf of iterations) rows.push(rowOf(member, node, leaf));
      } else {
        rows.push(rowOf(member, node, node));
      }
    }
  }
  return rows;
}

/** Excel runs a cell that opens with one of these. */
const FORMULA_LEAD = /^[=+\-@]/;

/**
 * One cell, safe for Excel.
 *
 * Two separate hazards, and the order matters — defuse first, then quote, or the quoting would be
 * computed against the wrong string:
 *
 * 1. **Formula injection.** Excel *executes* a cell starting `=`, `+`, `-` or `@`. Reachable here
 *    without anyone being hostile: `expected` can hold a Rhai expression, and `error` is whatever
 *    the server said. A leading apostrophe makes Excel treat it as text.
 * 2. **Quoting.** RFC 4180: a field containing a comma, a quote or a newline is wrapped in quotes,
 *    and an inner quote is doubled. Error messages carry all three — `must be one of: PUSH, PULL`
 *    is one real example.
 *
 * Everything else is left bare, so the file stays readable in a text editor.
 */
function cell(value: string): string {
  const defused = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(defused) ? `"${defused.replace(/"/g, '""')}"` : defused;
}

/**
 * The rows as a CSV Excel will open correctly.
 *
 * The **BOM** is the part that looks superstitious and is not: without it Excel reads the file in
 * its local codepage, and these labels are full of `→` and `—` (a real step is called
 * "Unusable credentials → /accounts/list"), which arrive as mojibake. CRLF for the same reason —
 * it is what Excel writes and expects.
 */
export function toCsv(rows: ExportRow[]): string {
  const lines = [COLUMNS.map((c) => cell(COLUMN_LABELS[c])).join(",")];
  for (const row of rows) lines.push(COLUMNS.map((c) => cell(row[c])).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

/**
 * A filename that says which run this was.
 *
 * Named after the run and the minute it started, because the reason you export two of these is to
 * compare them, and `run.csv` twice in a downloads folder defeats that. Lower-cased and
 * punctuation-stripped so it survives every filesystem — a suite called
 * "Upload numbers / Ent Admin" would otherwise carry a path separator.
 */
export function exportFileName(run: SuiteRun): string {
  const slug = (run.suite_name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const started = new Date(run.started_at);
  const stamp = Number.isNaN(started.getTime())
    ? ""
    : `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}-${pad(
        started.getHours(),
      )}${pad(started.getMinutes())}`;
  // "run-" rather than a nameless file: a suite whose name is blank still has to download somewhere
  // findable.
  return `${slug || "run"}-${stamp}.csv`.replace(/-+\.csv$/, ".csv");
}

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * Hand the file to the browser.
 *
 * The one impure function here, kept apart from the three above so the shape of the sheet stays
 * testable with plain values. A Blob and a synthetic `<a download>` — `URL.revokeObjectURL` in a
 * `finally`, because the object URL pins the whole file in memory until it is released and a
 * hundred-row export of a twenty-member run is not small.
 */
export function downloadRunCsv(run: SuiteRun): void {
  // text/csv with a charset, so a browser that sniffs does not decide this is plain text and a
  // download manager gives it the right icon. The BOM inside covers Excel either way.
  const blob = new Blob([toCsv(runRows(run))], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFileName(run);
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

