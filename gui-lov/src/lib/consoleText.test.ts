import { describe, it, expect } from "vitest";
import { formatLog, formatLogs } from "@/lib/consoleText";
import type { ConsoleLog } from "@/hooks/useExecutionStream";

const at = (hhmmss: string) => `2026-07-27T${hhmmss}Z`;

describe("consoleText", () => {
  it("writes an entry as a timestamped line", () => {
    const log: ConsoleLog = {
      timestamp: at("09:15:00"),
      message: "▶ Running: Login as PA",
      type: "info",
    };
    expect(formatLog(log)).toMatch(/^\[\d\d:\d\d:\d\d\] ▶ Running: Login as PA$/);
  });

  it("includes details even though the row may be collapsed on screen", () => {
    const log: ConsoleLog = {
      timestamp: at("09:15:01"),
      message: "✗ Delete User: failed",
      type: "error",
      details: [
        { label: "Request", value: "DELETE http://host/accounts/1" },
        { label: "Response", value: '{\n  "status": 403\n}' },
      ],
    };
    const lines = formatLog(log).split("\n");
    expect(lines[1]).toBe("  Request: DELETE http://host/accounts/1");
    // A multi-line body keeps its shape, indented as a block under its label.
    expect(lines.slice(2)).toEqual(["  Response:", "    {", '      "status": 403', "    }"]);
  });

  it("joins entries in order, one run per paste", () => {
    const logs: ConsoleLog[] = [
      { timestamp: at("09:15:00"), message: "first", type: "info" },
      { timestamp: at("09:15:02"), message: "second", type: "success" },
    ];
    const out = formatLogs(logs).split("\n");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("first");
    expect(out[1]).toContain("second");
  });

  it("handles an empty console", () => {
    expect(formatLogs([])).toBe("");
  });
});

describe("copying a fanned-out run", () => {
  it("keeps every row's verdict, not just its request", () => {
    // The verdict lives on the collapsed line as a `note`; a formatter that only knew
    // about label and value would paste the requests and lose which of them failed.
    const text = formatLog({
      timestamp: "2026-07-31T09:15:00Z",
      message: "✗ Send SMS: 1/2 rows passed",
      type: "error",
      details: [
        { label: "Error", value: "1 of 2 rows did not pass", type: "error" },
        { label: "✓  1  valid", note: "201  40ms", value: "Request: POST http://host/a" },
        {
          label: "✗  2  no sender",
          note: "400  12ms  Expected HTTP 201, got 400",
          value: "Request: POST http://host/b\nStatus: 400",
          type: "error",
        },
      ],
    });

    expect(text).toContain("Error: 1 of 2 rows did not pass");
    // The row line reads as a sentence, so it takes no colon.
    expect(text).toContain("✗  2  no sender  400  12ms  Expected HTTP 201, got 400");
    expect(text).not.toContain("no sender  400  12ms  Expected HTTP 201, got 400:");
    // And its request follows, indented under it.
    expect(text).toContain("    Status: 400");
    expect(text).toContain("    Request: POST http://host/a");
  });
});
