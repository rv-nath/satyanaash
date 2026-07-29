import { describe, it, expect } from "vitest";
import {
  fanOutDetails,
  pretty,
  resultDetails,
  resultHeadline,
  rowsSummary,
} from "@/lib/consoleDetails";
import type { TestCaseExecutionResult } from "@/lib/api/types";

const row = (
  index: number,
  label: string,
  status: TestCaseExecutionResult["status"],
  httpStatus: number,
  error?: string,
): TestCaseExecutionResult => ({
  node_id: "b",
  status,
  duration_ms: 40 + index,
  logs: [],
  row_index: index,
  row_label: label,
  request: { method: "POST", url: `http://host/sms?n=${index}`, headers: {}, body: `{"n":${index}}` },
  response: { status: httpStatus, headers: {}, body: '{"ok":true}' },
  ...(error ? { error_message: error } : {}),
});

const aggregate = (rows: TestCaseExecutionResult[]): TestCaseExecutionResult => ({
  node_id: "b",
  test_case_name: "Send SMS",
  status: rows.some((r) => r.status !== "passed") ? "failed" : "passed",
  duration_ms: 1240,
  logs: ["[valid] ⚠ something worth saying"],
  iterations: rows,
  ...(rows.some((r) => r.status !== "passed")
    ? { error_message: `${rows.filter((r) => r.status !== "passed").length} of ${rows.length} rows did not pass` }
    : {}),
});

describe("resultDetails", () => {
  it("keeps the labels the console has always shown", () => {
    // Regression guard for swapping the hook's duplicated type for the shared one.
    const details = resultDetails({
      node_id: "n1",
      status: "failed",
      duration_ms: 12,
      logs: ["⚠ Unresolved variable(s) sent literally: {{token}}"],
      request: { method: "GET", url: "http://host/x", headers: { A: "1" }, body: '{"a":1}' },
      response: { status: 401, headers: {}, body: '{"msg":"no"}' },
      error_message: "Assertion failed",
      exports: { token: "T" },
    });
    expect(details.map((d) => d.label)).toEqual([
      "Request", "Headers", "Payload", "Status", "Response", "Error", "Logs", "Exports",
    ]);
    // A 4xx status reads as an error, and JSON is pretty-printed.
    expect(details.find((d) => d.label === "Status")!.type).toBe("error");
    expect(details.find((d) => d.label === "Payload")!.value).toBe('{\n  "a": 1\n}');
  });

  it("passes a non-JSON body through untouched", () => {
    expect(pretty("plain text")).toBe("plain text");
  });
});

describe("rowsSummary", () => {
  it("gives every row one aligned line", () => {
    const lines = rowsSummary([
      row(0, "valid", "passed", 201),
      row(2, "no sender", "failed", 400, "Expected HTTP 201, got 400"),
    ]).split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("✓");
    expect(lines[0]).toContain("valid");
    expect(lines[0]).toContain("201");
    // Row numbers are the dataset position, not the position in the selection.
    expect(lines[1]).toMatch(/✗\s+3\s+no sender/);
    expect(lines[1]).toContain("Expected HTTP 201, got 400");
  });
});

describe("fanOutDetails", () => {
  it("blocks out only the rows that didn't pass", () => {
    const details = fanOutDetails(
      aggregate([
        row(0, "valid", "passed", 201),
        row(1, "also fine", "passed", 201),
        row(2, "no sender", "failed", 400, "Expected HTTP 201, got 400"),
      ]),
    );
    const labels = details.map((d) => d.label);
    expect(labels[0]).toBe("Rows");
    // One block, for the one failure — a green fan-out stays one screen.
    expect(labels.filter((l) => l.startsWith("Row "))).toEqual(["Row 3 · no sender"]);
    const block = details.find((d) => d.label === "Row 3 · no sender")!;
    expect(block.value).toContain("POST http://host/sms?n=2");
    expect(block.value).toContain("Status: 400");
  });

  it("doesn't repeat each row's logs, which the aggregate already carries", () => {
    const failing = row(0, "valid", "failed", 400, "nope");
    failing.logs = ["a row note"];
    const details = fanOutDetails(aggregate([failing]));
    const block = details.find((d) => d.label.startsWith("Row "))!;
    expect(block.value).not.toContain("a row note");
    expect(details.find((d) => d.label === "Logs")!.value).toContain("⚠ something worth saying");
  });
});

describe("a skipped row", () => {
  const skipped: TestCaseExecutionResult = {
    node_id: "direct",
    status: "skipped",
    duration_ms: 0,
    logs: ["Needs a flow — \"Run dataset\" has no earlier steps to satisfy it"],
    row_index: 1,
    row_label: "needs a login",
    error_message: 'Needs a flow — "Run dataset" has no earlier steps to satisfy it',
  };

  it("gets no block of its own, having sent nothing", () => {
    // Colouring an empty block red would say something went wrong when nothing did.
    const details = fanOutDetails({
      node_id: "direct", status: "passed", duration_ms: 40, logs: [],
      iterations: [row(0, "runs cold", "passed", 401), skipped],
    });
    expect(details.filter((d) => d.label.startsWith("Row "))).toHaveLength(0);
    // It is still visible in the summary, with its reason.
    expect(details[0].value).toContain("needs a login");
    expect(details[0].value).toContain("Needs a flow");
  });

  it("shows a dash where an HTTP code would be, keeping the columns aligned", () => {
    const lines = rowsSummary([row(0, "runs cold", "passed", 401), skipped]).split("\n");
    expect(lines[1]).toContain("—");
    expect(lines[1]).not.toMatch(/skipped\s+0ms/);
  });

  it("is left out of the headline's denominator, not counted as a failure", () => {
    const line = resultHeadline(
      {
        node_id: "direct", status: "passed", duration_ms: 40, logs: [],
        iterations: [row(0, "runs cold", "passed", 401), skipped],
      },
      "Login",
    );
    // Not "1/2 rows passed" beside a ✓, which contradicts itself.
    expect(line).toContain("1/1 rows passed (1 needed a flow)");
    expect(line.startsWith("✓")).toBe(true);
  });
});

describe("resultHeadline", () => {
  it("counts rows when a node fanned out", () => {
    const line = resultHeadline(
      aggregate([row(0, "a", "passed", 201), row(1, "b", "failed", 400)]),
      "Send SMS",
    );
    expect(line).toContain("1/2 rows passed");
  });

  it("reads as before for a single request, teardown included", () => {
    const single: TestCaseExecutionResult = {
      node_id: "t", status: "skipped", duration_ms: 0, logs: [], teardown: true,
    };
    expect(resultHeadline(single, "Delete User")).toBe("○ Delete User [teardown]: skipped (0ms)");
  });
});
