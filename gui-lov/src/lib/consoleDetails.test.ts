import { describe, it, expect } from "vitest";
import {
  fanOutDetails,
  pretty,
  resultDetails,
  resultHeadline,
  rowsSummary,
  worthFolding,
  detailSummary,
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
  it("lists every row exactly once", () => {
    // It used to list all of them in a summary and then repeat the failures as blocks
    // underneath, so a failing row appeared twice and a passing one had no way to show
    // its request at all.
    const details = fanOutDetails(
      aggregate([
        row(0, "valid", "passed", 201),
        row(1, "also fine", "passed", 201),
        row(2, "no sender", "failed", 400, "Expected HTTP 201, got 400"),
      ]),
    );

    const rowEntries = details.filter((d) => d.note !== undefined);
    expect(rowEntries).toHaveLength(3);
    expect(rowEntries.map((d) => d.label.trim())).toEqual([
      "✓  1  valid",
      "✓  2  also fine",
      "✗  3  no sender",
    ]);
    // Only the one that didn't pass is coloured as a problem.
    expect(rowEntries.map((d) => d.type)).toEqual([undefined, undefined, "error"]);
  });

  it("puts each row's record in that row's own block", () => {
    // "Which row produced this id" is the question. One block above the table answered it
    // only via a `_row` field the reader had to cross-reference — the long way round.
    const step = {
      ...aggregate([row(0, "10 recipients", "passed", 202), row(1, "100 recipients", "passed", 202)]),
      exports: {
        campaign_info: [
          { campaignId: "c-8871", txnId: "t-41", _row: "10 recipients" },
          { campaignId: "c-8872", txnId: "t-42", _row: "100 recipients" },
        ],
      },
    };
    const details = fanOutDetails(step);
    const rowEntries = details.filter((d) => d.note !== undefined);

    expect(rowEntries[0].label).toContain("10 recipients");
    expect(rowEntries[0].value).toContain("c-8871");
    expect(rowEntries[0].value).toContain("t-41");
    // And emphatically not the other row's id.
    expect(rowEntries[0].value).not.toContain("c-8872");
    expect(rowEntries[1].value).toContain("c-8872");

    // No separate block, because every record found its row.
    expect(details.some((d) => d.label.startsWith("Collected"))).toBe(false);
  });

  it("still surfaces a record no row claimed", () => {
    // Should not happen. If it does, an odd-looking extra block beats silently dropping a
    // value the engine collected.
    const step = {
      ...aggregate([row(0, "10 recipients", "passed", 202)]),
      exports: { campaign_info: [{ campaignId: "c-9", _row: "a row that is not here" }] },
    };
    const details = fanOutDetails(step);
    const block = details.find((d) => d.label === "Collected, unmatched");
    expect(block?.value).toContain("c-9");
  });

  it("says nothing about a collection when there isn't one", () => {
    const details = fanOutDetails(aggregate([row(0, "valid", "passed", 201)]));
    expect(details.some((d) => d.label.startsWith("Collected"))).toBe(false);
  });

  it("puts a row's verdict on its collapsed line and its request behind it", () => {
    const details = fanOutDetails(
      aggregate([row(2, "no sender", "failed", 400, "Expected HTTP 201, got 400")]),
    );
    const entry = details.find((d) => d.note !== undefined)!;

    // Scannable without opening anything.
    expect(entry.note).toContain("400");
    expect(entry.note).toContain("Expected HTTP 201, got 400");
    // And the whole request and response one click away — for passing rows too, which
    // previously had nowhere to show them.
    expect(entry.value).toContain("POST http://host/sms?n=2");
    expect(entry.value).toContain("Status: 400");
  });

  it("aligns the row names into a column", () => {
    // The console is monospace, so padding the label is all alignment takes.
    const details = fanOutDetails(
      aggregate([row(0, "short", "passed", 201), row(1, "a much longer name", "passed", 201)]),
    );
    const [a, b] = details.filter((d) => d.note !== undefined);
    expect(a.label).toHaveLength(b.label.length);
  });

  it("leads with the summary rather than footnoting it", () => {
    // "1 of 2 rows did not pass" underneath the rows reads as a footnote; above them it
    // says what you are about to look at.
    const agg = aggregate([
      row(0, "valid", "passed", 201),
      row(1, "no sender", "failed", 400, "Expected HTTP 201, got 400"),
    ]);
    const labels = fanOutDetails(agg).map((d) => d.label);
    expect(labels[0]).toBe("Error");
  });

  it("doesn't repeat each row's logs, which the aggregate already carries", () => {
    const failing = row(0, "valid", "failed", 400, "nope");
    failing.logs = ["a row note"];
    const details = fanOutDetails(aggregate([failing]));
    const entry = details.find((d) => d.note !== undefined)!;
    expect(entry.value).not.toContain("a row note");
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

  it("holds its reason rather than an empty request, and isn't coloured as a problem", () => {
    const details = fanOutDetails({
      node_id: "direct", status: "passed", duration_ms: 40, logs: [],
      iterations: [row(0, "runs cold", "passed", 401), skipped],
    });
    const entry = details.filter((d) => d.note !== undefined)[1];

    expect(entry.label).toContain("needs a login");
    // Nothing was sent, so the reason is the whole of it.
    expect(entry.value).toContain("Needs a flow");
    expect(entry.value).not.toContain("Request:");
    // Nothing went wrong, so nothing is red.
    expect(entry.type).toBeUndefined();
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
    // Not "1/2 rows passed" beside a ✓, which contradicts itself — but it must still say
    // a row went unrun, or a green line reads as coverage it doesn't have.
    expect(line).toContain("1/1 rows passed (1 of 2 not run)");
    expect(line.startsWith("✓")).toBe(true);
  });

  it("says plainly when nothing ran at all", () => {
    // "0/0 rows passed" beside a ○ is a riddle, and a green one would be a lie.
    const line = resultHeadline(
      {
        node_id: "direct", status: "skipped", duration_ms: 0, logs: [],
        iterations: [skipped, { ...skipped, row_index: 1, row_label: "also parked" }],
      },
      "Send SMS",
    );
    expect(line).toContain("nothing ran");
    expect(line).toContain("all 2 rows are parked or need a flow");
    expect(line).not.toContain("rows passed");
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

describe("folding a big detail", () => {
  it("leaves a short value where the author can already see it", () => {
    // Opening an entry shouldn't turn into a second round of clicking.
    expect(worthFolding("400")).toBe(false);
    expect(worthFolding('{\n  "ok": true\n}')).toBe(false);
    // A ten-line log is the diagnosis, not the noise.
    expect(worthFolding(Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"))).toBe(false);
  });

  it("folds the monsters — a bearer token, a whole payload, a fanned-out row", () => {
    // One enormous line: the case that prompted this.
    expect(worthFolding(`Authorization: Bearer ${"e".repeat(2400)}`)).toBe(true);
    // Or many short ones.
    expect(worthFolding(Array.from({ length: 11 }, (_, i) => `"k${i}": ${i},`).join("\n"))).toBe(true);
  });

  it("says enough about a folded value to judge it unopened", () => {
    expect(detailSummary("e".repeat(2400))).toBe("2.3 KB");
    expect(detailSummary("a\nb\nc")).toBe("3 lines · 5 chars");
    // A single line reports only its size — "1 lines" reads like a bug.
    expect(detailSummary("just one line")).toBe("13 chars");
  });
});
