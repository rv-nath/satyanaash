/**
 * Turning a node's result into the console's collapsible details.
 *
 * Pulled out of the SSE handler for two reasons: a node that ran one request per data
 * row needs the same treatment applied per row, and the arithmetic of "which rows
 * passed" is worth testing without an event stream.
 */
import type { TestCaseExecutionResult } from "@/lib/api/types";
import { attemptsNote } from "@/lib/poll";

export interface ConsoleLogDetail {
  label: string;
  value: string;
  type?: "info" | "error";
  /** Shown beside the label on the collapsed line, in place of the size. For a data row
   *  that is its verdict — the status, the time, and why — so the list of rows reads as a
   *  table without needing a second copy of itself underneath. */
  note?: string;
}

/** Pretty-print a JSON body; anything else is passed through untouched. */
export function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/** The one-character verdict. Shared with the canvas, so a node's badge and its
 *  console line can never disagree. */
export const statusIcon = (status: TestCaseExecutionResult["status"]): string =>
  status === "passed" ? "✓" : status === "failed" ? "✗" : status === "error" ? "⚠" : "○";

/** Request, response, error, logs and exports for a single request. */
export function resultDetails(result: TestCaseExecutionResult): ConsoleLogDetail[] {
  const details: ConsoleLogDetail[] = [];

  if (result.request) {
    details.push({ label: "Request", value: `${result.request.method} ${result.request.url}` });
    if (result.request.headers && Object.keys(result.request.headers).length > 0) {
      details.push({ label: "Headers", value: JSON.stringify(result.request.headers, null, 2) });
    }
    if (result.request.body) {
      details.push({ label: "Payload", value: pretty(result.request.body) });
    }
  }

  if (result.response) {
    details.push({
      label: "Status",
      value: String(result.response.status),
      type: result.response.status >= 400 ? "error" : "info",
    });
    if (result.response.body) {
      details.push({ label: "Response", value: pretty(result.response.body.trim()) });
    }
  }

  if (result.error_message) {
    details.push({ label: "Error", value: result.error_message, type: "error" });
  }
  // Engine notes: unresolved variables, assertion reasons, script output, provenance.
  if (result.logs && result.logs.length > 0) {
    details.push({ label: "Logs", value: result.logs.join("\n") });
  }
  if (result.exports && Object.keys(result.exports).length > 0) {
    details.push({ label: "Exports", value: JSON.stringify(result.exports, null, 2) });
  }

  return details;
}

/** How wide the name column has to be for a set of rows to line up. */
const labelWidth = (rows: TestCaseExecutionResult[]): number =>
  Math.max(0, ...rows.map((r) => (r.row_label ?? "").length));

/** A row's identity: its number and name, padded so a column of them lines up. The
 *  console is monospace, so padding is all alignment takes. */
export function rowHeading(row: TestCaseExecutionResult, width: number): string {
  const n = String((row.row_index ?? 0) + 1).padStart(2);
  return `${statusIcon(row.status)} ${n}  ${(row.row_label ?? "").padEnd(width)}`;
}

/** A row's verdict: what came back, how long it took, and why it didn't pass. */
export function rowVerdict(row: TestCaseExecutionResult): string {
  // The status column is sized for an HTTP code; a request that never went out has
  // none, so say so rather than overflowing the alignment with a word.
  const status = row.response ? String(row.response.status) : "—";
  const reason = row.error_message ? `  ${row.error_message}` : "";
  return `${status.padStart(3)}  ${row.duration_ms}ms${reason}`;
}

/** One aligned line per row: the matrix at a glance, and copyable as text. */
export function rowsSummary(rows: TestCaseExecutionResult[]): string {
  const width = labelWidth(rows);
  return rows.map((row) => `${rowHeading(row, width)}  ${rowVerdict(row)}`).join("\n");
}

/**
 * Details for a node that ran once per row.
 *
 * Every row gets a line in the summary; only rows that didn't pass get their own block.
 * A fifty-row green fan-out then stays one screen, while a failure still shows the
 * request and response that produced it.
 */
export function fanOutDetails(aggregate: TestCaseExecutionResult): ConsoleLogDetail[] {
  const rows = aggregate.iterations ?? [];
  const details: ConsoleLogDetail[] = [];
  const width = labelWidth(rows);

  // Introduces the rows rather than footnoting them.
  if (aggregate.error_message) {
    details.push({ label: "Error", value: aggregate.error_message, type: "error" });
  }

  for (const row of rows) {
    const failed = row.status !== "passed" && row.status !== "skipped";
    // A row that was never sent has no request or response to show, so its reason is the
    // whole of it. Everything else carries its request and response, folded — the per-row
    // logs left out, since the aggregate already holds every row's, prefixed.
    const value =
      row.status === "skipped"
        ? (row.error_message ?? "Not run")
        : resultDetails({ ...row, logs: [] })
            .map((d) => `${d.label}: ${d.value}`)
            .join("\n");
    details.push({
      label: rowHeading(row, width),
      note: rowVerdict(row),
      value,
      ...(failed ? { type: "error" as const } : {}),
    });
  }

  if (aggregate.logs && aggregate.logs.length > 0) {
    details.push({ label: "Logs", value: aggregate.logs.join("\n") });
  }

  return details;
}

/**
 * Whether a detail is big enough to arrive folded.
 *
 * The thresholds are deliberately generous. What makes an expanded entry unreadable is
 * a handful of monsters — a bearer token in the headers, a whole campaign payload, a
 * fanned-out row's complete request and response — not a ten-line log. Fold those and
 * leave everything else where the author can already see it, so opening an entry does
 * not turn into a second round of clicking.
 */
const FOLD_CHARS = 600;
const FOLD_LINES = 10;

export function worthFolding(value: string): boolean {
  return value.length > FOLD_CHARS || value.split("\n").length > FOLD_LINES;
}

/** What a folded detail says about itself, so it can be judged unopened. */
export function detailSummary(value: string): string {
  const lines = value.split("\n").length;
  const size = value.length < 1024
    ? `${value.length} chars`
    : `${(value.length / 1024).toFixed(1)} KB`;
  // One enormous line (a JWT) and forty short ones are both worth folding, but for
  // different reasons — say whichever one this is.
  return lines > 1 ? `${lines} lines · ${size}` : size;
}

/** The console's headline for a result — "6/8 rows passed" when it fanned out. */
export function resultHeadline(result: TestCaseExecutionResult, name: string): string {
  const suffix = result.teardown ? " [teardown]" : "";
  const rows = result.iterations;
  if (rows) {
    const passed = rows.filter((r) => r.status === "passed").length;
    const skipped = rows.filter((r) => r.status === "skipped").length;
    // Skipped rows are excluded from the denominator rather than counted as failures, so
    // "3/3 rows passed (1 not run)" reads with a ✓ instead of contradicting it. But it
    // has to *say* so: "3/3 rows passed" beside two rows nobody ran reads as complete
    // coverage, which is how a parked row becomes a way of hiding a case from yourself.
    const ran = rows.length - skipped;
    const note = skipped > 0 ? ` (${skipped} of ${rows.length} not run)` : "";
    // Every row skipped is not a pass. The engine reports the aggregate as skipped; say
    // it in words too, because "0/0 rows passed" beside a ○ is a riddle.
    if (ran === 0) {
      return `${statusIcon(result.status)} ${name}${suffix}: nothing ran — all ${rows.length} rows are parked or need a flow (${result.duration_ms}ms)`;
    }
    return `${statusIcon(result.status)} ${name}${suffix}: ${passed}/${ran} rows passed${note} (${result.duration_ms}ms)`;
  }
  // A poll's duration is the whole wait, so the attempt count is what makes it legible:
  // "4.2s" alone cannot tell one slow request from three quick ones and two waits.
  const attempts = attemptsNote(result.attempts, result.duration_ms);
  if (attempts) {
    return `${statusIcon(result.status)} ${name}${suffix}: ${result.status} (${attempts})`;
  }
  return `${statusIcon(result.status)} ${name}${suffix}: ${result.status} (${result.duration_ms}ms)`;
}
