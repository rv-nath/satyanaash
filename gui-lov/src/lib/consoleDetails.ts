/**
 * Turning a node's result into the console's collapsible details.
 *
 * Pulled out of the SSE handler for two reasons: a node that ran one request per data
 * row needs the same treatment applied per row, and the arithmetic of "which rows
 * passed" is worth testing without an event stream.
 */
import type { TestCaseExecutionResult } from "@/lib/api/types";

export interface ConsoleLogDetail {
  label: string;
  value: string;
  type?: "info" | "error";
}

/** Pretty-print a JSON body; anything else is passed through untouched. */
export function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

const icon = (status: TestCaseExecutionResult["status"]): string =>
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

/** One aligned line per row: the matrix at a glance, and copyable as text. */
export function rowsSummary(rows: TestCaseExecutionResult[]): string {
  const width = Math.max(0, ...rows.map((r) => (r.row_label ?? "").length));
  return rows
    .map((row) => {
      const n = String((row.row_index ?? 0) + 1).padStart(2);
      const label = (row.row_label ?? "").padEnd(width);
      const status = row.response ? String(row.response.status) : row.status;
      const reason = row.error_message ? `  ${row.error_message}` : "";
      return `${icon(row.status)} ${n}  ${label}  ${status.padStart(3)}  ${row.duration_ms}ms${reason}`;
    })
    .join("\n");
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
  const details: ConsoleLogDetail[] = [{ label: "Rows", value: rowsSummary(rows) }];

  for (const row of rows) {
    if (row.status === "passed") continue;
    const label = `Row ${(row.row_index ?? 0) + 1} · ${row.row_label ?? ""}`.trim();
    // Reuse the single-request details, minus the per-row logs — the aggregate already
    // carries every row's logs, prefixed, so repeating them here would double them up.
    const value = resultDetails({ ...row, logs: [] })
      .map((d) => `${d.label}: ${d.value}`)
      .join("\n");
    details.push({ label, value, type: "error" });
  }

  if (aggregate.error_message) {
    details.push({ label: "Error", value: aggregate.error_message, type: "error" });
  }
  if (aggregate.logs && aggregate.logs.length > 0) {
    details.push({ label: "Logs", value: aggregate.logs.join("\n") });
  }

  return details;
}

/** The console's headline for a result — "6/8 rows passed" when it fanned out. */
export function resultHeadline(result: TestCaseExecutionResult, name: string): string {
  const suffix = result.teardown ? " [teardown]" : "";
  const rows = result.iterations;
  if (rows) {
    const passed = rows.filter((r) => r.status === "passed").length;
    return `${icon(result.status)} ${name}${suffix}: ${passed}/${rows.length} rows passed (${result.duration_ms}ms)`;
  }
  return `${icon(result.status)} ${name}${suffix}: ${result.status} (${result.duration_ms}ms)`;
}
