/**
 * The workbook's shape.
 *
 * Everything worth arguing about is in `workbookSheets` — what the summary says, which rows read as
 * bad, where the rules between flows fall — so it is pure and tested here with plain values. The
 * ExcelJS half is a loop with no decisions in it.
 */
import { describe, it, expect } from "vitest";
import { workbookSheets, xlsxFileName, buildWorkbook } from "@/lib/runWorkbook";
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
  suite_name: "Smoking Gun Test",
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

const sheetNamed = (r: SuiteRun, name: string) => workbookSheets(r).find((s) => s.name === name)!;

describe("which sheets, and in what order", () => {
  it("opens on the summary, then the failures, then everything", () => {
    // Failures before Results because it is the sheet you came for, and it is derived rather than
    // authored — the same columns, filtered.
    const sheets = workbookSheets(
      run([member({ results: [step({ status: "failed" }), step({ status: "passed" })] })]),
    );
    expect(sheets.map((s) => s.name)).toEqual(["Summary", "Failures", "Results"]);
  });

  it("leaves the failures sheet out when nothing failed", () => {
    // An empty sheet headed "Failures" reads as a load that did not finish; no sheet reads as
    // nothing to see.
    const sheets = workbookSheets(run([member({ results: [step({ status: "passed" })] })]));
    expect(sheets.map((s) => s.name)).toEqual(["Summary", "Results"]);
  });

  it("counts an error as something to put on the failures sheet", () => {
    const sheets = workbookSheets(run([member({ results: [step({ status: "error" })] })]));
    expect(sheets.map((s) => s.name)).toContain("Failures");
  });

  it("puts only the failures on that sheet", () => {
    const failures = sheetNamed(
      run([
        member({
          results: [
            step({ status: "passed", test_case_name: "fine" }),
            step({ status: "failed", test_case_name: "broken" }),
            step({ status: "skipped", test_case_name: "parked" }),
          ],
        }),
      ]),
      "Failures",
    );
    expect(failures.rows).toHaveLength(1);
    expect(failures.rows[0].cells).toContain("broken");
  });
});

describe("the summary", () => {
  it("states steps and results as two figures, each naming its unit", () => {
    // The whole reason this sheet exists. The app's headline counts steps; the thing you read is
    // results, and one run has 126 of the first and 229 of the second. One line saying "86/126"
    // sent a reader to the chart looking for the rest.
    const summary = sheetNamed(
      run(
        [
          member({
            results: [
              step({
                status: "failed",
                iterations: [step({ status: "failed" }), step({ status: "skipped" })],
              }),
            ],
          }),
        ],
        { total: 1, passed: 0, skipped: 0 },
      ),
      "Summary",
    );
    const facts = Object.fromEntries(summary.preamble);
    expect(facts.Steps).toBe("0/1 passed");
    // Two leaves, one skipped — a fact the headline's own `skipped: 0` cannot express.
    expect(facts.Results).toBe("0/2 passed · 1 skipped");
  });

  it("says how many of the members were flows and how many were standalone tests", () => {
    const summary = sheetNamed(
      run([
        member({ member_kind: "flow", results: [step()] }),
        member({ member_kind: "test", results: [step()] }),
        member({ member_kind: "test", results: [step()] }),
      ]),
      "Summary",
    );
    expect(Object.fromEntries(summary.preamble)["Flows / tests"]).toBe("1 flows · 2 tests");
  });

  it("gives every member a row and totals them at the bottom", () => {
    const summary = sheetNamed(
      run([
        member({ name: "a", results: [step({ status: "failed" })] }),
        member({ name: "b", results: [step({ status: "passed" }), step({ status: "passed" })] }),
      ]),
      "Summary",
    );
    expect(summary.rows).toHaveLength(3);
    const total = summary.rows.at(-1)!;
    expect(total.cells[0]).toBe("Total");
    expect(total.tone).toBe("total");
    // steps, results, passed, failed
    expect(total.cells.slice(2, 6)).toEqual([3, 3, 2, 1]);
  });

  it("marks a member that failed, and mutes one that only skipped", () => {
    const summary = sheetNamed(
      run([
        member({ name: "broke", results: [step({ status: "error" })] }),
        member({ name: "parked", results: [step({ status: "skipped" })] }),
        member({ name: "fine", results: [step({ status: "passed" })] }),
      ]),
      "Summary",
    );
    expect(summary.rows.slice(0, 3).map((r) => r.tone)).toEqual(["bad", "muted", "plain"]);
  });
});

describe("how a row reads", () => {
  const results = (r: SuiteRun) => sheetNamed(r, "Results");

  it("marks failed and errored rows as bad", () => {
    const sheet = results(
      run([member({ results: [step({ status: "failed" }), step({ status: "error" })] })]),
    );
    expect(sheet.rows.map((r) => r.tone)).toEqual(["bad", "bad"]);
  });

  it("mutes a skipped row rather than reddening it", () => {
    // 46 failed and 46 skipped in one real run: red on both would double the apparent damage and
    // bury the half you can act on. A skipped row is not a failure, it is one that never ran.
    const sheet = results(run([member({ results: [step({ status: "skipped" })] })]));
    expect(sheet.rows[0].tone).toBe("muted");
  });

  it("keeps ms and attempts as numbers, so Excel can sort and sum them", () => {
    const sheet = results(run([member({ results: [step({ duration_ms: 412, attempts: 3 })] })]));
    const ms = sheet.columns.findIndex((c) => c.label === "ms");
    const attempts = sheet.columns.findIndex((c) => c.label === "attempts");
    expect(sheet.rows[0].cells[ms]).toBe(412);
    expect(sheet.rows[0].cells[attempts]).toBe(3);
  });

  it("leaves a blank number blank rather than making it zero", () => {
    // "Did not poll" is not "polled zero times", and a 0 would sort and average as though it were.
    const sheet = results(run([member({ results: [step()] })]));
    const attempts = sheet.columns.findIndex((c) => c.label === "attempts");
    expect(sheet.rows[0].cells[attempts]).toBe("");
  });
});

describe("where the rules between flows fall", () => {
  it("closes a block when the flow changes", () => {
    const sheet = sheetNamed(
      run([
        member({ name: "first", results: [step(), step()] }),
        member({ name: "second", results: [step()] }),
      ]),
      "Results",
    );
    expect(sheet.rows.map((r) => !!r.endsGroup)).toEqual([false, true, true]);
  });

  it("keeps a fan-out step's rows inside one block", () => {
    // Forty data rows of one step are one thing, not forty — which is the reading the border is
    // there to give.
    const sheet = sheetNamed(
      run([
        member({
          name: "only",
          results: [
            step({ iterations: [step({ row_label: "a" }), step({ row_label: "b" }), step({ row_label: "c" })] }),
          ],
        }),
      ]),
      "Results",
    );
    expect(sheet.rows.map((r) => !!r.endsGroup)).toEqual([false, false, true]);
  });

  it("closes the last block, so the table has a bottom", () => {
    const sheet = sheetNamed(run([member({ results: [step()] })]), "Results");
    expect(sheet.rows.at(-1)!.endsGroup).toBe(true);
  });
});

describe("the data sheets", () => {
  it("head their first column `flow / test`, not `member`", () => {
    const sheet = sheetNamed(run([member({ results: [step()] })]), "Results");
    expect(sheet.columns[0].label).toBe("flow / test");
  });

  it("carry no preamble, so the header is row one and freezing it is enough", () => {
    const sheet = sheetNamed(run([member({ results: [step()] })]), "Results");
    expect(sheet.preamble).toEqual([]);
  });
});

describe("xlsxFileName", () => {
  it("matches the CSV name but for the extension", () => {
    expect(xlsxFileName(run([], { suite_name: "auth-boundary" }))).toMatch(/^auth-boundary-.*\.xlsx$/);
  });
});

/**
 * The rendered file, not the description of it.
 *
 * Everything above proves the intent. This proves the result: a workbook is built for real, then
 * read back, because "Excel opens it and shows none of the formatting" is the failure the
 * description-level tests cannot see. No DOM involved — that is why `buildWorkbook` is separate
 * from the download.
 */
describe("the workbook that actually gets written", () => {
  const sample = () =>
    run(
      [
        member({
          name: "auth-boundary",
          member_kind: "flow",
          results: [
            step({
              test_case_name: "Auth boundary",
              status: "failed",
              iterations: [
                step({ status: "failed", row_label: "garbage bearer", duration_ms: 412 }),
                step({ status: "skipped", row_label: "parked row" }),
              ],
            }),
          ],
        }),
        member({ name: "Balance Enquiry", member_kind: "test", results: [step({ status: "passed" })] }),
      ],
      { total: 2, passed: 1 },
    );

  it("writes the three sheets", async () => {
    const wb = await buildWorkbook(sample());
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "Failures", "Results"]);
  });

  it("freezes the header wherever the preamble left it", async () => {
    const wb = await buildWorkbook(sample());
    // Results has no preamble, so its header is row 1.
    expect(wb.getWorksheet("Results")!.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    // Summary has eight preamble lines plus a spacer, so its header is row 10 — and freezing row 1
    // there would pin a label/value line instead of the table's header.
    expect(wb.getWorksheet("Summary")!.views[0]).toMatchObject({ state: "frozen", ySplit: 10 });
  });

  it("turns on the filter over the header row, so filtering costs no keystroke", async () => {
    const wb = await buildWorkbook(sample());
    const ws = wb.getWorksheet("Results")!;
    expect(ws.autoFilter).toMatchObject({ from: { row: 1, column: 1 } });
  });

  it("decorates the header: bold, light on a dark fill, ruled underneath", async () => {
    const wb = await buildWorkbook(sample());
    const header = wb.getWorksheet("Results")!.getRow(1);
    expect(header.font?.bold).toBe(true);
    expect(header.fill).toMatchObject({ type: "pattern", pattern: "solid" });
    expect(header.getCell(1).border?.bottom?.style).toBe("thin");
    expect(header.getCell(1).value).toBe("flow / test");
  });

  it("reddens a failed row and greys a skipped one, in the same file", async () => {
    const wb = await buildWorkbook(sample());
    const ws = wb.getWorksheet("Results")!;
    // Row 1 is the header; the fan-out's two leaves follow.
    const failed = ws.getRow(2);
    const skipped = ws.getRow(3);
    expect(failed.getCell(5).value).toBe("failed");
    expect(skipped.getCell(5).value).toBe("skipped");
    expect(failed.font?.color?.argb).toBe("FFB42318");
    expect(skipped.font?.color?.argb).toBe("FF98A2B3");
    expect(failed.font?.color?.argb).not.toBe(skipped.font?.color?.argb);
  });

  it("rules between one flow and the next, and not between a step's own rows", async () => {
    const wb = await buildWorkbook(sample());
    const ws = wb.getWorksheet("Results")!;
    // Rows 2 and 3 are one flow's two data rows; 4 is the next member.
    expect(ws.getRow(2).getCell(1).border?.bottom).toBeUndefined();
    expect(ws.getRow(3).getCell(1).border?.bottom?.style).toBe("thin");
    expect(ws.getRow(4).getCell(1).border?.bottom?.style).toBe("thin");
  });

  it("keeps ms a number in the file, so a column of them can be sorted", async () => {
    const wb = await buildWorkbook(sample());
    const ms = wb.getWorksheet("Results")!.getRow(2).getCell(10).value;
    expect(ms).toBe(412);
    expect(typeof ms).toBe("number");
  });

  it("sets a width on every column, so nothing has to be dragged open", async () => {
    const wb = await buildWorkbook(sample());
    const ws = wb.getWorksheet("Results")!;
    for (let i = 1; i <= 13; i++) expect(ws.getColumn(i).width).toBeGreaterThan(0);
  });

  it("survives a round trip through the xlsx encoder", async () => {
    // The one check that the file is a file: written to a buffer and parsed back by the same
    // library. A workbook that only exists in memory has proved nothing about what Excel receives.
    const wb = await buildWorkbook(sample());
    const buffer = await wb.xlsx.writeBuffer();
    expect(buffer.byteLength).toBeGreaterThan(1000);

    const ExcelJS = await import("exceljs");
    const reread = new ExcelJS.Workbook();
    await reread.xlsx.load(buffer as ArrayBuffer);
    expect(reread.worksheets.map((w) => w.name)).toEqual(["Summary", "Failures", "Results"]);
    const ws = reread.getWorksheet("Results")!;
    expect(ws.getRow(1).getCell(1).value).toBe("flow / test");
    expect(ws.getRow(2).font?.color?.argb).toBe("FFB42318");
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
  });
});
