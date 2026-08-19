/**
 * A run as a formatted workbook.
 *
 * The CSV beside this is one flat sheet, which is the right thing for filtering and the wrong thing
 * for reading: it cannot say which rows failed without you looking at a column, cannot keep the
 * header in view past row forty, and cannot show where one flow ends and the next begins. Those are
 * spreadsheet features, not text features, so this is xlsx.
 *
 * **The shape is decided here and rendered elsewhere.** `workbookSheets` is pure — it returns what
 * the sheets contain and how each row should read — and `downloadRunXlsx` walks that into ExcelJS.
 * Keeping the split means every judgement worth arguing about (what the summary says, which rows
 * are red, where the borders fall) is testable with plain values, and the untestable part is a
 * twenty-line loop with no decisions in it.
 *
 * ExcelJS rather than SheetJS: the community SheetJS build cannot *write* cell styles, which is
 * four of the six things this file exists to do.
 */
import type { SuiteRun, FlowRun } from "@/lib/api/types";
import {
  COLUMNS,
  COLUMN_LABELS,
  COLUMN_WIDTHS,
  exportFileName,
  runRows,
  type ExportRow,
} from "@/lib/runExport";

/**
 * How a row should read at a glance.
 *
 * `muted` exists because of a real proportion: one run here has 46 failed leaves and 46 skipped
 * ones. Colouring both red would double the apparent damage and bury the half you can act on — a
 * skipped row is not a failure, it is a row that never ran.
 */
export type RowTone = "plain" | "bad" | "muted" | "total";

export interface SheetRow {
  /** In column order. Numbers stay numbers so Excel can sort and sum them — the one thing a CSV
   *  of everything-as-text cannot offer. */
  cells: (string | number)[];
  tone: RowTone;
  /** Last row of a flow/test block: draws the rule that separates it from the next. */
  endsGroup?: boolean;
}

export interface Sheet {
  name: string;
  /** Label/value lines above the table. The data sheets have none. */
  preamble: [string, string][];
  columns: { label: string; width: number }[];
  rows: SheetRow[];
}

const toneOf = (verdict: string): RowTone =>
  verdict === "failed" || verdict === "error" ? "bad" : verdict === "skipped" ? "muted" : "plain";

/** The leaf table, as a sheet. Rows already arrive in run order from `runRows`. */
function dataSheet(name: string, rows: ExportRow[]): Sheet {
  return {
    name,
    preamble: [],
    columns: COLUMNS.map((c) => ({ label: COLUMN_LABELS[c], width: COLUMN_WIDTHS[c] })),
    rows: rows.map((row, i) => ({
      cells: COLUMNS.map((c) => (c === "ms" || c === "attempts" ? numeric(row[c]) : row[c])),
      tone: toneOf(row.verdict),
      // The border falls where the flow/test changes, so a block of forty data rows reads as one
      // thing rather than forty. On the last row too, which closes the final block.
      endsGroup: i === rows.length - 1 || rows[i + 1].member !== row.member,
    })),
  };
}

/** Blank stays blank rather than becoming 0 — "did not poll" is not "polled zero times". */
const numeric = (value: string): string | number => (value === "" ? "" : Number(value));

interface MemberTally {
  member: FlowRun;
  steps: number;
  results: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
}

function tallyMembers(run: SuiteRun): MemberTally[] {
  return (run.members ?? []).map((member) => {
    const t: MemberTally = {
      member,
      steps: (member.results ?? []).length,
      results: 0,
      passed: 0,
      failed: 0,
      errors: 0,
      skipped: 0,
    };
    for (const node of member.results ?? []) {
      for (const leaf of node.iterations?.length ? node.iterations : [node]) {
        t.results += 1;
        if (leaf.status === "passed") t.passed += 1;
        else if (leaf.status === "failed") t.failed += 1;
        else if (leaf.status === "error") t.errors += 1;
        else if (leaf.status === "skipped") t.skipped += 1;
      }
    }
    return t;
  });
}

const SUMMARY_COLUMNS = [
  { label: "flow / test", width: 30 },
  { label: "kind", width: 6 },
  { label: "steps", width: 8 },
  { label: "results", width: 9 },
  { label: "passed", width: 8 },
  { label: "failed", width: 8 },
  { label: "errors", width: 8 },
  { label: "skipped", width: 9 },
  { label: "ms", width: 10 },
];

/**
 * What the run was, and the two totals that disagree.
 *
 * This sheet exists for one number. The app's headline counts **steps** — 86 of 126 — while the
 * thing you need to read is **results**, of which the same run has 229, 46 of them skipped against
 * the headline's 3. Neither figure is wrong; they count different units, and no screen said so.
 * Putting both here, labelled, is the smallest honest fix.
 */
function summarySheet(run: SuiteRun, rows: ExportRow[]): Sheet {
  const tallies = tallyMembers(run);
  const sum = (pick: (t: MemberTally) => number) => tallies.reduce((n, t) => n + pick(t), 0);

  return {
    name: "Summary",
    preamble: [
      ["Run", run.suite_name],
      ["Started", run.started_at],
      ["Duration", run.duration_ms == null ? "" : `${Math.round(run.duration_ms / 1000)}s`],
      ["Environment", run.environment_name ?? ""],
      ["Status", run.status],
      // Said as two lines on purpose, each naming its unit. One line reading "86/126" is what sent
      // a reader to the chart looking for the other 143.
      ["Steps", `${run.passed}/${run.total} passed`],
      ["Results", `${sum((t) => t.passed)}/${rows.length} passed · ${sum((t) => t.skipped)} skipped`],
      ["Flows / tests", `${tallies.filter((t) => t.member.member_kind === "flow").length} flows · ${
        tallies.filter((t) => t.member.member_kind === "test").length
      } tests`],
    ],
    columns: SUMMARY_COLUMNS,
    rows: [
      ...tallies.map((t) => ({
        cells: [
          t.member.name,
          t.member.member_kind,
          t.steps,
          t.results,
          t.passed,
          t.failed,
          t.errors,
          t.skipped,
          t.member.duration_ms ?? "",
        ],
        tone: toneOf(t.failed + t.errors > 0 ? "failed" : t.results === t.skipped ? "skipped" : "passed"),
      })),
      {
        cells: [
          "Total",
          "",
          sum((t) => t.steps),
          rows.length,
          sum((t) => t.passed),
          sum((t) => t.failed),
          sum((t) => t.errors),
          sum((t) => t.skipped),
          run.duration_ms ?? "",
        ],
        tone: "total" as RowTone,
      },
    ],
  };
}

/**
 * The three sheets, in the order you would open them.
 *
 * Summary first because it settles what the run was; **Failures** before Results because it is the
 * sheet you actually came for, and it is derived rather than authored — the same columns, filtered.
 * Absent entirely when nothing failed: an empty sheet headed "Failures" reads as a load that did
 * not finish, where no sheet at all reads as nothing to see.
 */
export function workbookSheets(run: SuiteRun): Sheet[] {
  const rows = runRows(run);
  const bad = rows.filter((r) => r.verdict === "failed" || r.verdict === "error");
  return [
    summarySheet(run, rows),
    ...(bad.length > 0 ? [dataSheet("Failures", bad)] : []),
    dataSheet("Results", rows),
  ];
}

export const xlsxFileName = (run: SuiteRun): string =>
  exportFileName(run).replace(/\.csv$/, ".xlsx");

/* ── Rendering ───────────────────────────────────────────────────────────────────────────
 *
 * Everything below hands the description above to ExcelJS. No decisions live here.
 */

const INK = { bad: "FFB42318", muted: "FF98A2B3", plain: "FF101828", head: "FFFFFFFF" };
const FILL_HEAD = "FF344054";
const RULE = "FFD0D5DD";

/**
 * The workbook itself, built but not delivered.
 *
 * Separate from the download for one reason: it is the only part of this file without a DOM in it,
 * so a test can build a real workbook, read it back, and check that the frozen header, the red
 * fonts and the rules between flows actually reached the file. Asserting on the description alone
 * would prove the intent and not the result — and "Excel opens it and shows nothing" is the failure
 * mode unit tests cannot see.
 *
 * ExcelJS is loaded by dynamic `import()` so it lands in its own chunk: it is close to a megabyte
 * with a zip implementation inside it, and only someone who exports should pay for that. The build
 * already warns about chunks over 500 kB.
 */
export async function buildWorkbook(run: SuiteRun) {
  const ExcelJS = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.creator = "satyanaash";

  for (const sheet of workbookSheets(run)) {
    const ws = wb.addWorksheet(sheet.name);

    for (const [label, value] of sheet.preamble) {
      const row = ws.addRow([label, value]);
      row.getCell(1).font = { bold: true, color: { argb: INK.plain } };
    }
    if (sheet.preamble.length > 0) ws.addRow([]);

    const headerRowNumber = ws.rowCount + 1;
    const header = ws.addRow(sheet.columns.map((c) => c.label));
    header.font = { bold: true, color: { argb: INK.head } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL_HEAD } };
    header.eachCell((c) => {
      c.border = { bottom: { style: "thin", color: { argb: RULE } } };
    });
    sheet.columns.forEach((c, i) => {
      ws.getColumn(i + 1).width = c.width;
    });

    for (const row of sheet.rows) {
      const added = ws.addRow(row.cells);
      if (row.tone === "bad") added.font = { color: { argb: INK.bad } };
      else if (row.tone === "muted") added.font = { color: { argb: INK.muted } };
      else if (row.tone === "total") added.font = { bold: true };
      if (row.endsGroup) {
        added.eachCell((c) => {
          c.border = { bottom: { style: "thin", color: { argb: RULE } } };
        });
      }
    }

    // Freeze at the header, wherever the preamble left it — and filter over the header's own row,
    // so filtering costs no keystroke.
    ws.views = [{ state: "frozen", ySplit: headerRowNumber }];
    ws.autoFilter = {
      from: { row: headerRowNumber, column: 1 },
      to: { row: headerRowNumber, column: sheet.columns.length },
    };
  }

  return wb;
}

/** Write it and hand it to the browser. */
export async function downloadRunXlsx(run: SuiteRun): Promise<void> {
  const wb = await buildWorkbook(run);
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = xlsxFileName(run);
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
