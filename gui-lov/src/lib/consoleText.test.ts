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
