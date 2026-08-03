/**
 * Shaping a run for the chart panel.
 *
 * Four presentations, one source. Kept pure so the arithmetic — which is where a chart
 * lies — is testable without a DOM.
 *
 * **Every view states its unit.** A run holds nodes *and* rows, and the stored headline
 * counts only nodes: one real run reads `total 49 · skipped 0` while 22 of its 65 rows
 * were skipped. A chart that silently mixed the two would show 54 passed beside a footer
 * saying 35, and neither number would be trusted again. So the top level counts nodes and
 * says so; drilling into a fan-out switches to rows and says that instead.
 */
import type { FlowRun, SuiteRun, TestCaseExecutionResult } from '@/lib/api/types';
import type { TreePath } from '@/lib/runTree';
import { nodeTitle } from '@/lib/runHistory';

export type RunChartView = 'breakdown' | 'slowest' | 'hierarchy';

/**
 * There was a fourth, `Profile`: a bar per slice of the current level.
 *
 * It was dropped rather than fixed, because it earned nothing at either level. At the run
 * level its four bars restated the summary line directly above it. One level down, every
 * bar was the same length — each member contributes exactly one failure, so length encoded
 * a constant, which is a list wearing a chart's clothes.
 *
 * If a bar chart comes back here it should encode the failure *ratio* — "1 of 8 steps" and
 * "1 of 1" are very different states and only the second means the member is entirely
 * broken. That is a different chart, not a fix to this one.
 */
export const CHART_VIEWS: { id: RunChartView; label: string; answers: string }[] = [
  { id: 'breakdown', label: 'Breakdown', answers: 'what is inside this slice' },
  { id: 'slowest', label: 'Slowest', answers: 'where did the time go' },
  { id: 'hierarchy', label: 'Hierarchy', answers: "the whole run's shape" },
];

export const DEFAULT_VIEW: RunChartView = 'breakdown';

export type Verdict = 'passed' | 'failed' | 'errored' | 'skipped';

export const VERDICTS: Verdict[] = ['passed', 'failed', 'errored', 'skipped'];

/**
 * Chart fills, re-stepped from the app's status hues and validated rather than eyeballed.
 *
 * The app's own colours fail as adjacent fills: `#25934d` green against `#d32222` red is
 * ΔE 5.2 under deuteranopia — a deuteranope cannot tell passed from failed. The tree gets
 * away with it because ✓ and ✗ carry the meaning; a stacked bar has no such help.
 *
 * Keeping the hue families and pushing *lightness* apart fixes it, because deuteranopia
 * collapses the hue and lightness survives: ΔE 23.1 (deutan), 25.4 (tritan), all five
 * checks pass. Re-run with:
 *
 *   node scripts/validate_palette.js "#4fb477,#a11212,#e0930f" --mode light --surface "#ffffff"
 *
 * `skipped` is deliberately below the chroma floor — it reads gray because a thing that
 * never ran should recede. It is never adjacent to another fill without a label.
 */
export const CHART_FILL: Record<Verdict, string> = {
  passed: '#4fb477',
  failed: '#a11212',
  errored: '#e0930f',
  skipped: '#9ca3af',
};

/** The mark beside every legend entry and tooltip, so status is never colour alone. */
export const VERDICT_ICON: Record<Verdict, string> = {
  passed: '✓',
  failed: '✗',
  errored: '!',
  skipped: '○',
};

export type Counts = Record<Verdict, number>;

export const emptyCounts = (): Counts => ({ passed: 0, failed: 0, errored: 0, skipped: 0 });

export function verdictOf(status: string): Verdict {
  if (status === 'passed') return 'passed';
  if (status === 'failed') return 'failed';
  if (status === 'error' || status === 'errored') return 'errored';
  return 'skipped';
}

export function tally(results: TestCaseExecutionResult[]): Counts {
  const counts = emptyCounts();
  for (const r of results) counts[verdictOf(r.status)] += 1;
  return counts;
}

export const total = (c: Counts): number =>
  c.passed + c.failed + c.errored + c.skipped;

/** What actually ran — the denominator "passed" is measured against. */
export const ran = (c: Counts): number => c.passed + c.failed + c.errored;

// ---------------------------------------------------------------- Profile

export interface MemberBar extends Counts {
  path: TreePath;
  name: string;
  kind: FlowRun['member_kind'];
  durationMs: number | null;
  /** Rows underneath this member's nodes. Reported, never added to the segments — the
   *  bar counts nodes, and mixing the two is exactly the trap this file guards. */
  rows: number;
  /** A member that executed nothing. Sized by count it would be invisible, which is how
   *  the current view hides `Flow 1`: green, 0 ms, no steps. */
  empty: boolean;
}

export function memberSeries(run: SuiteRun): MemberBar[] {
  return (run.members ?? []).map((member, index) => {
    const nodes = member.results ?? [];
    const counts = tally(nodes);
    return {
      ...counts,
      path: { member: index },
      name: member.name,
      kind: member.member_kind,
      durationMs: member.duration_ms ?? null,
      rows: nodes.reduce((sum, n) => sum + (n.iterations?.length ?? 0), 0),
      empty: nodes.length === 0,
    };
  });
}

// ---------------------------------------------------------------- Drill-down

/**
 * Where the reader is looking.
 *
 * One navigation model, shared by every presentation. The first version gave each view its
 * own idea of position — seventeen bars in one, an unrelated donut in another — which is
 * how four views became four puzzle pieces instead of one picture. Switching view now
 * changes only the geometry, never where you are.
 *
 * It leads with the verdict rather than the member list, because "38 failed → which
 * members?" is the question, and a wall of seventeen bars makes you answer it by reading
 * every label.
 */
export type Focus =
  | { kind: 'run' }
  | { kind: 'verdict'; verdict: Verdict }
  | { kind: 'member'; member: number }
  | { kind: 'node'; member: number; node: number };

/** What the level being shown is counting, said in words. */
export type Unit = 'verdicts' | 'members' | 'steps' | 'rows';

export interface Slice {
  label: string;
  value: number;
  verdict: Verdict;
  /** Where clicking goes, when there is anywhere to go. */
  next?: Focus;
  /** What clicking selects in the tree. Absent at the run level — a verdict is not a
   *  place in the run. */
  path?: TreePath;
  /** Shown beside the label: a duration, a row count, whatever the level makes useful. */
  note?: string;
}

export interface Level {
  unit: Unit;
  /** Outermost first, so it renders as a breadcrumb and each crumb is clickable. */
  crumbs: { label: string; focus: Focus }[];
  /** Totals for what is on screen. Every level answers "how many, of what". */
  counts: Counts;
  slices: Slice[];
}

export const RUN: Focus = { kind: 'run' };

export function focusPath(focus: Focus): TreePath | null {
  if (focus.kind === 'member') return { member: focus.member };
  if (focus.kind === 'node') return { member: focus.member, node: focus.node };
  return null;
}

export function levelAt(run: SuiteRun, focus: Focus): Level {
  const members = run.members ?? [];
  const crumbs: { label: string; focus: Focus }[] = [{ label: 'Run', focus: RUN }];

  if (focus.kind === 'run') {
    const counts = runCounts(run);
    return {
      unit: 'verdicts',
      crumbs,
      counts,
      // Only verdicts that happened. A zero-width "0 errored" segment is noise, and the
      // totals row above already says it was zero.
      slices: VERDICTS.filter((v) => counts[v] > 0).map((v) => ({
        label: v,
        value: counts[v],
        verdict: v,
        next: { kind: 'verdict', verdict: v },
      })),
    };
  }

  if (focus.kind === 'verdict') {
    crumbs.push({ label: focus.verdict, focus });
    const slices: Slice[] = [];
    const counts = emptyCounts();

    members.forEach((member, index) => {
      const nodes = member.results ?? [];
      const own = tally(nodes)[focus.verdict];
      // A member that ran nothing has no verdict of its own to contribute, but hiding it
      // is how the current view loses `Flow 1`. It shows under whatever the fold made it.
      const empty = nodes.length === 0 && verdictOf(member.status) === focus.verdict;
      if (own === 0 && !empty) return;
      counts[focus.verdict] += own || 1;
      slices.push({
        label: member.name,
        value: own || 1,
        verdict: focus.verdict,
        next: { kind: 'member', member: index },
        path: { member: index },
        note: empty ? 'nothing ran' : `${own} of ${nodes.length}`,
      });
    });

    return { unit: 'members', crumbs, counts, slices };
  }

  const member = members[focus.member];
  if (!member) return { unit: 'members', crumbs, counts: emptyCounts(), slices: [] };
  const nodes = member.results ?? [];
  crumbs.push({ label: member.name, focus: { kind: 'member', member: focus.member } });

  if (focus.kind === 'member') {
    return {
      unit: 'steps',
      crumbs,
      counts: tally(nodes),
      slices: nodes.map((node, index) => {
        const rows = node.iterations ?? [];
        return {
          label: nodeTitle(node),
          value: 1,
          verdict: verdictOf(node.status),
          next: rows.length > 0 ? { kind: 'node', member: focus.member, node: index } : undefined,
          path: { member: focus.member, node: index },
          note: rows.length > 0 ? rowSummaryOf(rows) : undefined,
        };
      }),
    };
  }

  const node = nodes[focus.node];
  const rows = node?.iterations ?? [];
  crumbs.push({ label: node ? nodeTitle(node) : 'step', focus });

  return {
    unit: 'rows',
    crumbs,
    counts: tally(rows),
    slices: rows.map((row, index) => ({
      label: row.row_label ?? `Row ${(row.row_index ?? index) + 1}`,
      value: 1,
      verdict: verdictOf(row.status),
      path: { member: focus.member, node: focus.node, row: index },
    })),
  };
}

function rowSummaryOf(rows: TestCaseExecutionResult[]): string {
  const counts = tally(rows);
  const denominator = ran(counts);
  if (denominator === 0) return `${rows.length} rows, none ran`;
  return counts.skipped > 0
    ? `${counts.passed}/${denominator} rows · ${counts.skipped} skipped`
    : `${counts.passed}/${denominator} rows`;
}

/** Worst-of across a member's nodes, falling back to the member's own recorded status
 *  when it has no nodes to fold. */
function worstOf(counts: Counts, fallback: string): Verdict {
  if (counts.errored > 0) return 'errored';
  if (counts.failed > 0) return 'failed';
  if (counts.passed > 0) return 'passed';
  return total(counts) > 0 ? 'skipped' : verdictOf(fallback);
}

/** Node-level counts for the whole run — the same unit the stored headline uses, so the
 *  chart and the footer cannot disagree. */
export function runCounts(run: SuiteRun): Counts {
  const counts = emptyCounts();
  for (const member of run.members ?? []) {
    for (const node of member.results ?? []) counts[verdictOf(node.status)] += 1;
  }
  return counts;
}

/** Row-level counts. Separate on purpose: this is what the headline leaves out. */
export function rowCounts(run: SuiteRun): Counts {
  const counts = emptyCounts();
  for (const member of run.members ?? []) {
    for (const node of member.results ?? []) {
      for (const row of node.iterations ?? []) counts[verdictOf(row.status)] += 1;
    }
  }
  return counts;
}

/**
 * What the headline leaves out, said in words.
 *
 * `countsLine` reports the stored figures, which count nodes — so a run whose dataset rows
 * were mostly skipped reads `35/49 passed · 14 failed` and never mentions the 22 rows that
 * did not run. Green by omission. This is the sentence that fixes it, and it names its
 * unit and denominator because that is the whole lesson: `22 of 65 rows skipped`.
 *
 * Empty when there is nothing to add, so it never pads a run that has no rows.
 */
export function rowsNote(run: SuiteRun): string {
  const rows = rowCounts(run);
  const count = total(rows);
  if (count === 0 || rows.skipped === 0) return '';
  return `${rows.skipped} of ${count} rows skipped`;
}

// ---------------------------------------------------------------- Slowest

export interface SlowStep {
  path: TreePath;
  label: string;
  /** Which member it came from. Four `Reset Password` bars are meaningless without it. */
  member: string;
  ms: number;
  verdict: Verdict;
}

export function slowestSteps(run: SuiteRun, limit = 10): SlowStep[] {
  const steps: SlowStep[] = [];

  (run.members ?? []).forEach((member, m) => {
    (member.results ?? []).forEach((node, n) => {
      const rows = node.iterations ?? [];
      if (rows.length > 0) {
        // A fan-out's own duration is the sum of its rows, so listing both would double
        // count. The rows are the requests that actually took the time.
        rows.forEach((row, r) => {
          steps.push({
            path: { member: m, node: n, row: r },
            label: `${nodeTitle(node)} · ${row.row_label ?? `Row ${(row.row_index ?? r) + 1}`}`,
            member: member.name,
            ms: row.duration_ms,
            verdict: verdictOf(row.status),
          });
        });
        return;
      }
      steps.push({
        path: { member: m, node: n },
        label: nodeTitle(node),
        member: member.name,
        ms: node.duration_ms,
        verdict: verdictOf(node.status),
      });
    });
  });

  // Nothing that took no time — a skipped step sent no request, so ranking it by 0 ms
  // would push real measurements off the chart.
  return steps
    .filter((s) => s.ms > 0)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, limit);
}

// ---------------------------------------------------------------- Hierarchy

export interface Arc {
  path: TreePath;
  label: string;
  /** 0 = members, 1 = nodes, 2 = rows. */
  ring: number;
  startAngle: number;
  endAngle: number;
  verdict: Verdict;
}

/** Smallest slice of the circle any member may occupy, so one that ran nothing is still
 *  visible and clickable rather than a hairline. */
const MIN_TURN = 0.012;

/**
 * The run as concentric rings, in degrees clockwise from twelve o'clock.
 *
 * Members share the circle by leaf count — a member with more work occupies more of it —
 * with a floor so nothing disappears. Each member's nodes divide its own span, and a
 * fan-out node's rows divide the node's.
 */
export function sunburstArcs(run: SuiteRun): Arc[] {
  const members = run.members ?? [];
  if (members.length === 0) return [];

  const weightOf = (member: FlowRun) => {
    const nodes = member.results ?? [];
    const leaves = nodes.reduce((sum, n) => sum + Math.max(n.iterations?.length ?? 0, 1), 0);
    return Math.max(leaves, 1);
  };

  const weights = members.map(weightOf);
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  // Give every member its floor first, then share what is left in proportion — so the
  // floor cannot make the angles sum to more than a full turn.
  const floor = Math.min(MIN_TURN, 1 / members.length);
  const spare = 1 - floor * members.length;

  const arcs: Arc[] = [];
  let cursor = 0;

  members.forEach((member, m) => {
    const span = (floor + (weights[m] / totalWeight) * spare) * 360;
    const nodes = member.results ?? [];
    arcs.push({
      path: { member: m },
      label: member.name,
      ring: 0,
      startAngle: cursor,
      endAngle: cursor + span,
      verdict: worstOf(tally(nodes), member.status),
    });

    if (nodes.length > 0) {
      const nodeWeights = nodes.map((n) => Math.max(n.iterations?.length ?? 0, 1));
      const nodeTotal = nodeWeights.reduce((a, b) => a + b, 0);
      let inner = cursor;

      nodes.forEach((node, n) => {
        const nodeSpan = (nodeWeights[n] / nodeTotal) * span;
        arcs.push({
          path: { member: m, node: n },
          label: nodeTitle(node),
          ring: 1,
          startAngle: inner,
          endAngle: inner + nodeSpan,
          verdict: verdictOf(node.status),
        });

        const rows = node.iterations ?? [];
        if (rows.length > 0) {
          const rowSpan = nodeSpan / rows.length;
          rows.forEach((row, r) => {
            arcs.push({
              path: { member: m, node: n, row: r },
              label: row.row_label ?? `Row ${(row.row_index ?? r) + 1}`,
              ring: 2,
              startAngle: inner + r * rowSpan,
              endAngle: inner + (r + 1) * rowSpan,
              verdict: verdictOf(row.status),
            });
          });
        }
        inner += nodeSpan;
      });
    }

    cursor += span;
  });

  return arcs;
}

/** SVG path for one arc band. Plain trig rather than a dependency: Recharts has no
 *  sunburst, and this is the whole of what d3-shape would have been imported for. */
export function arcPath(
  arc: Pick<Arc, 'startAngle' | 'endAngle'>,
  inner: number,
  outer: number,
  cx = 0,
  cy = 0,
): string {
  // Clockwise from twelve o'clock, which is how a reader expects a ring to start.
  // Rounded: cos(90°) is 6.1e-17, and unrounded that reaches the DOM as
  // "M 3.67394039744206e-15 -60".
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const point = (radius: number, deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [round(cx + radius * Math.cos(rad)), round(cy + radius * Math.sin(rad))];
  };
  const sweep = arc.endAngle - arc.startAngle;
  const large = sweep > 180 ? 1 : 0;

  // A full turn cannot be drawn as one arc — the start and end points coincide and the
  // path collapses. Two halves.
  if (sweep >= 359.999) {
    const [x1, y1] = point(outer, 0);
    const [x2, y2] = point(outer, 180);
    const [x3, y3] = point(inner, 180);
    const [x4, y4] = point(inner, 0);
    return [
      `M ${x1} ${y1}`,
      `A ${outer} ${outer} 0 1 1 ${x2} ${y2}`,
      `A ${outer} ${outer} 0 1 1 ${x1} ${y1}`,
      `L ${x4} ${y4}`,
      `A ${inner} ${inner} 0 1 0 ${x3} ${y3}`,
      `A ${inner} ${inner} 0 1 0 ${x4} ${y4}`,
      'Z',
    ].join(' ');
  }

  const [sox, soy] = point(outer, arc.startAngle);
  const [eox, eoy] = point(outer, arc.endAngle);
  const [eix, eiy] = point(inner, arc.endAngle);
  const [six, siy] = point(inner, arc.startAngle);

  return [
    `M ${sox} ${soy}`,
    `A ${outer} ${outer} 0 ${large} 1 ${eox} ${eoy}`,
    `L ${eix} ${eiy}`,
    `A ${inner} ${inner} 0 ${large} 0 ${six} ${siy}`,
    'Z',
  ].join(' ');
}

/** Wide enough to hold text? Below this an arc gets no label and relies on hover, which
 *  is the "selective direct labels" rule rather than a compromise. */
export const LABEL_MIN_DEGREES = 14;
