import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  Cell,
  Label,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { SuiteRun } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/runHistory";
import { samePath, type TreePath } from "@/lib/runTree";
import {
  arcPath,
  CHART_FILL,
  CHART_VIEWS,
  focusPath,
  levelAt,
  LABEL_MIN_DEGREES,
  ran,
  rowCounts,
  RUN,
  runCounts,
  slowestSteps,
  sunburstArcs,
  total,
  VERDICT_ICON,
  VERDICTS,
  type Focus,
  type Level,
  type RunChartView,
  type Slice,
} from "@/lib/runCharts";

/**
 * A run as a picture: totals first, then drill in.
 *
 * The first version gave each view its own idea of position — seventeen bars in one, an
 * unrelated donut in another, no totals anywhere — which made four views read as four
 * puzzle pieces. Now there is **one** navigation (`Focus`), **one** summary, and the
 * switcher changes only the geometry. Switching view never moves you.
 *
 * It also leads with the verdict rather than the member list. "38 failed → which members?"
 * is the question; a wall of seventeen labelled bars makes you answer it by reading.
 *
 * Fills come from `CHART_FILL`, re-stepped from the app's status hues and validated: the
 * theme's own green and red are ΔE 5.2 apart under deuteranopia, i.e. indistinguishable.
 * The tree survives that because ✓ and ✗ carry the meaning; a bar has no such help, which
 * is why every legend entry, label and tooltip here carries its icon.
 */
interface Props {
  run: SuiteRun;
  view: RunChartView;
  onViewChange: (view: RunChartView) => void;
  selected: TreePath | null;
  onSelect: (path: TreePath) => void;
}

const RunChart = ({ run, view, onViewChange, selected, onSelect }: Props) => {
  // Where the reader is looking. Owned here, so every view shares it.
  const [focus, setFocus] = useState<Focus>(RUN);
  const level = useMemo(() => levelAt(run, focus), [run, focus]);

  // Opening a slice also selects it, so the tree follows what you are exploring.
  const open = (slice: Slice) => {
    if (slice.path) onSelect(slice.path);
    if (slice.next) setFocus(slice.next);
  };

  const goTo = (next: Focus) => {
    setFocus(next);
    const path = focusPath(next);
    if (path) onSelect(path);
  };

  return (
    <div className="flex h-full flex-col">
      <Summary run={run} level={level} onCrumb={goTo} />

      <div className="flex items-center gap-1 border-b border-border px-3 py-1">
        {CHART_VIEWS.map((v) => (
          <Button
            key={v.id}
            variant="ghost"
            size="sm"
            onClick={() => onViewChange(v.id)}
            title={v.answers}
            className={`h-6 px-2 text-xs ${
              v.id === view ? "bg-primary/15 text-foreground" : "text-muted-foreground"
            }`}
          >
            {v.label}
          </Button>
        ))}
        <div className="flex-1" />
        {/* Hidden rather than clipped on a narrow pane — "where" on its own said nothing.
            Each button also carries this as its title. */}
        <span className="hidden shrink-0 whitespace-nowrap text-[10px] text-muted-foreground lg:inline">
          {CHART_VIEWS.find((v) => v.id === view)?.answers}
        </span>
      </div>

      <div className="min-h-0 flex-1">
        {view === "profile" && <LevelBars level={level} onOpen={open} />}
        {view === "breakdown" && <LevelDonut level={level} onOpen={open} />}
        {view === "slowest" && <Slowest run={run} selected={selected} onSelect={onSelect} />}
        {view === "hierarchy" && <Hierarchy run={run} selected={selected} onSelect={onSelect} />}
      </div>
    </div>
  );
};

/**
 * The line every view sits under: what this run did, where you are, and the key.
 *
 * Present in all four views precisely because it was missing from all four — a chart whose
 * numbers you have to hover for is a chart you read once and stop trusting.
 */
const Summary = ({
  run,
  level,
  onCrumb,
}: {
  run: SuiteRun;
  level: Level;
  onCrumb: (focus: Focus) => void;
}) => {
  const nodes = runCounts(run);
  const rows = rowCounts(run);

  return (
    <div className="border-b border-border px-3 py-1.5">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        {VERDICTS.map((v) => (
          <span key={v} className="flex items-baseline gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 translate-y-[1px] rounded-sm"
              style={{ background: CHART_FILL[v] }}
              aria-hidden
            />
            <span className="text-sm font-medium tabular-nums">{nodes[v]}</span>
            <span className="text-[10px] text-muted-foreground">
              {VERDICT_ICON[v]} {v}
            </span>
          </span>
        ))}
        {/* The unit, always — and spelled out on hover, because "49 steps" invites exactly
            the question of whether datasets are in it. They are not: a 19-row dataset is
            one step, which is the engine's own rule so that `total` means one thing. */}
        <span
          className="cursor-help text-[10px] text-muted-foreground underline decoration-dotted underline-offset-2"
          title={
            `${total(nodes)} steps: one per request in a flow, and one per standalone test ` +
            `even when it carries a dataset.` +
            (total(rows) > 0
              ? ` The ${total(rows)} data rows inside those steps are counted separately — ` +
                `${total(nodes) + total(rows)} requests or skips in total.`
              : '')
          }
        >
          of {total(nodes)} steps
          {total(rows) > 0 &&
            ` · ${total(rows)} dataset rows inside them${rows.skipped > 0 ? `, ${rows.skipped} skipped` : ""}`}
        </span>
      </div>

      <div className="mt-1 flex items-center gap-1.5 text-[10px]">
        {/* An explicit way out. The breadcrumb alone did not read as navigable — it looked
            like a caption, so drilling in felt like a one-way door. */}
        {level.crumbs.length > 1 && (
          <Button
            variant="outline"
            size="sm"
            className="h-5 gap-1 px-1.5 text-[10px]"
            onClick={() => onCrumb(level.crumbs[level.crumbs.length - 2].focus)}
          >
            <ChevronLeft className="h-3 w-3" /> Back
          </Button>
        )}
        {level.crumbs.map((crumb, i) => {
          const here = i === level.crumbs.length - 1;
          return (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <ChevronRight className="h-2.5 w-2.5 shrink-0 text-muted-foreground/50" />}
              <button
                type="button"
                disabled={here}
                onClick={() => onCrumb(crumb.focus)}
                className={
                  here
                    ? "font-medium text-foreground"
                    : "text-primary underline decoration-dotted underline-offset-2 hover:decoration-solid"
                }
              >
                {crumb.label}
              </button>
            </span>
          );
        })}
        <span className="ml-1 text-muted-foreground">
          · {level.slices.length} {level.unit}
          {level.unit !== "verdicts" && ran(level.counts) > 0 &&
            ` · ${level.counts.passed}/${ran(level.counts)} passed`}
        </span>
      </div>
    </div>
  );
};

/**
 * The label past the end of a bar, addressed by index.
 *
 * Recharts' `label.formatter` receives only the value, so looking the row up by it matched
 * the *first* row with that value — and at member level a dozen rows share the value 1,
 * which would put the first one's note on all of them. Index is the only identity a row
 * actually has here.
 */
const barLabel =
  (text: (index: number) => string) =>
  ({ x, y, width, height, index }: {
    x?: number; y?: number; width?: number; height?: number; index?: number;
  }) => (
    <text
      x={(x ?? 0) + (width ?? 0) + 6}
      y={(y ?? 0) + (height ?? 0) / 2}
      dominantBaseline="central"
      className="fill-foreground"
      style={{ fontSize: 10 }}
    >
      {text(index ?? 0)}
    </text>
  );

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="p-4 text-xs text-muted-foreground">{children}</p>
);

const Box = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded border border-border bg-card px-2 py-1 text-xs shadow-md">{children}</div>
);

const sliceTooltip = (slice: Slice | undefined) => {
  if (!slice) return null;
  return (
    <Box>
      <div className="font-medium">{slice.label}</div>
      <div className="text-muted-foreground">
        {VERDICT_ICON[slice.verdict]} {slice.verdict}
        {slice.note && ` · ${slice.note}`}
      </div>
      {slice.next && <div className="text-primary">click to open</div>}
    </Box>
  );
};

// ---------------------------------------------------------------- Profile

/**
 * The current level as bars — one per slice, longest first at the run level.
 *
 * At the run level that is four bars, not seventeen: `passed 2 · failed 2`. The members
 * are one click in, which is where they mean something.
 */
const LevelBars = ({ level, onOpen }: { level: Level; onOpen: (s: Slice) => void }) => {
  if (level.slices.length === 0) return <Empty>Nothing to show at this level.</Empty>;

  const height = Math.max(level.slices.length * 28 + 16, 96);
  // Room at the right for the label that sits past the bar end. Without it the longest
  // bar runs to the edge and its number is clipped.
  const gutter = level.slices.some((s) => s.note) ? 140 : 56;

  return (
    <div className="h-full overflow-y-auto px-2 py-1 focus:outline-none">
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          data={level.slices}
          layout="vertical"
          barSize={14}
          margin={{ left: 4, right: gutter, top: 4, bottom: 4 }}
        >
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="label"
            width={150}
            tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: "hsl(var(--muted) / 0.3)" }}
            content={({ payload }) => sliceTooltip(payload?.[0]?.payload as Slice | undefined)}
          />
          <Bar
            dataKey="value"
            isAnimationActive={false}
            radius={[0, 4, 4, 0]}
            // On the bar, not in a footnote underneath. A number listed somewhere else is
            // a number the reader has to pair up by eye, which is the same as hiding it.
            label={barLabel((i) => {
              const slice = level.slices[i];
              if (!slice) return "";
              return slice.note ? `${slice.value}  ${slice.note}` : String(slice.value);
            })}
          >
            {level.slices.map((slice, i) => (
              <Cell
                key={i}
                fill={CHART_FILL[slice.verdict]}
                cursor={slice.next ? "pointer" : "default"}
                onClick={() => onOpen(slice)}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      {level.slices.some((s) => s.next) && (
        <p className="px-2 pb-1 text-[10px] text-muted-foreground/70">
          Click a bar to open it.
        </p>
      )}
    </div>
  );
};

// ---------------------------------------------------------------- Breakdown

const LevelDonut = ({ level, onOpen }: { level: Level; onOpen: (s: Slice) => void }) => {
  if (level.slices.length === 0) return <Empty>Nothing to break down at this level.</Empty>;

  const whole = Math.max(total(level.counts), 1);

  return (
    <div className="flex h-full items-center justify-center gap-6 p-2">
      {/* `focus:outline-none` on the wrapper: Recharts makes its surface focusable, and a
          browser drew a black rectangle round the whole donut on click. The keyboard ring
          is kept — it is the mouse-click outline that is noise. */}
      <div className="h-full min-h-0 w-[45%] max-w-[280px] [&_.recharts-surface]:outline-none [&_.recharts-wrapper]:outline-none">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={level.slices}
              dataKey="value"
              nameKey="label"
              innerRadius="56%"
              outerRadius="84%"
              paddingAngle={2}
              isAnimationActive={false}
              rootTabIndex={-1}
            >
              {level.slices.map((slice, i) => (
                <Cell
                  key={i}
                  fill={CHART_FILL[slice.verdict]}
                  stroke="hsl(var(--card))"
                  strokeWidth={2}
                  cursor={slice.next ? "pointer" : "default"}
                  onClick={() => onOpen(slice)}
                />
              ))}
              {/* The hole is the obvious place for the total, and it was empty. */}
              <Label
                position="center"
                content={() => (
                  <>
                    <text
                      x="50%"
                      y="47%"
                      textAnchor="middle"
                      className="fill-foreground"
                      style={{ fontSize: 18, fontWeight: 500 }}
                    >
                      {whole}
                    </text>
                    <text
                      x="50%"
                      y="59%"
                      textAnchor="middle"
                      className="fill-muted-foreground"
                      style={{ fontSize: 9 }}
                    >
                      {level.unit}
                    </text>
                  </>
                )}
              />
            </Pie>
            <Tooltip
              content={({ payload }) => sliceTooltip(payload?.[0]?.payload as Slice | undefined)}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* A donut without its numbers beside it is a shape. Kept narrow and left-aligned:
          stretched across the pane, the name sat on one side and its count on the other,
          which is a table you have to read across a gap. */}
      <ul className="max-h-full min-w-0 max-w-[300px] flex-1 overflow-y-auto text-[11px]">
        {level.slices.map((slice, i) => {
          const share = Math.round((slice.value / whole) * 100);
          return (
            <li key={i}>
              <button
                type="button"
                onClick={() => onOpen(slice)}
                className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-muted/30"
              >
                <span
                  className="inline-block h-2 w-2 shrink-0 translate-y-[1px] rounded-sm"
                  style={{ background: CHART_FILL[slice.verdict] }}
                  aria-hidden
                />
                <span className="w-7 shrink-0 text-right font-medium tabular-nums">
                  {slice.value}
                </span>
                <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">
                  {share}%
                </span>
                <span className="min-w-0 truncate">{slice.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

// ---------------------------------------------------------------- Slowest

const Slowest = ({
  run,
  selected,
  onSelect,
}: {
  run: SuiteRun;
  selected: TreePath | null;
  onSelect: (p: TreePath) => void;
}) => {
  const steps = useMemo(() => slowestSteps(run, 12), [run]);
  // How many there were to rank, so "slowest 12" says what it is 12 of. A cap that does
  // not say what it left out reads as "that is all there is".
  const measured = useMemo(() => slowestSteps(run, Number.MAX_SAFE_INTEGER).length, [run]);
  if (steps.length === 0) return <Empty>No step has taken measurable time yet.</Empty>;

  const height = Math.max(steps.length * 22 + 16, 120);
  const slowest = steps[0].ms;

  return (
    <div className="h-full overflow-y-auto px-2 py-1">
      <p className="px-2 pb-1 text-[10px] text-muted-foreground">
        {/* Steps and rows, not members — these are individual requests, and several can
            come from one member. Saying "of 17 members" was simply wrong. */}
        slowest {steps.length} of {measured} timed requests · {formatDuration(run.duration_ms)} for
        the whole run
      </p>
      <ResponsiveContainer width="100%" height={height}>
        {/* Wide right gutter: the label past the bar end carries the member name, which is
            the whole reason four `Reset Password` bars are not interchangeable. */}
        <BarChart data={steps} layout="vertical" barSize={12} margin={{ left: 4, right: 230 }}>
          <XAxis type="number" hide domain={[0, slowest]} />
          <YAxis
            type="category"
            dataKey="label"
            width={150}
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: "hsl(var(--muted) / 0.3)" }}
            content={({ payload }) => {
              const step = payload?.[0]?.payload as (typeof steps)[number] | undefined;
              if (!step) return null;
              return (
                <Box>
                  <div className="font-medium">{step.label}</div>
                  {/* Which member it came from. Four `Reset Password` bars are meaningless
                      without it. */}
                  <div className="text-muted-foreground">in {step.member}</div>
                  <div className="text-muted-foreground">
                    {formatDuration(step.ms)} · {VERDICT_ICON[step.verdict]} {step.verdict}
                  </div>
                </Box>
              );
            }}
          />
          <Bar
            dataKey="ms"
            isAnimationActive={false}
            radius={[0, 4, 4, 0]}
            // On the bar, not in a list underneath — the list overlapped the last bars and
            // made the reader match rows to bars by eye.
            label={barLabel((i) => {
              const step = steps[i];
              return step ? `${formatDuration(step.ms)}   in ${step.member}` : "";
            })}
          >
            {steps.map((step, i) => (
              <Cell
                key={i}
                fill={CHART_FILL[step.verdict]}
                cursor="pointer"
                stroke={samePath(selected, step.path) ? "hsl(var(--foreground))" : "transparent"}
                strokeWidth={1.5}
                onClick={() => onSelect(step.path)}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};

// ---------------------------------------------------------------- Hierarchy

const SIZE = 250;
const RINGS = [
  { inner: 32, outer: 58 },
  { inner: 60, outer: 86 },
  { inner: 88, outer: 110 },
];

const Hierarchy = ({
  run,
  selected,
  onSelect,
}: {
  run: SuiteRun;
  selected: TreePath | null;
  onSelect: (p: TreePath) => void;
}) => {
  const arcs = useMemo(() => sunburstArcs(run), [run]);
  const [hovered, setHovered] = useState<(typeof arcs)[number] | null>(null);
  if (arcs.length === 0) return <Empty>Nothing has run yet.</Empty>;

  const counts = runCounts(run);
  const RING_NAMES = ["member", "step", "row"];

  return (
    <div className="flex h-full items-center justify-center gap-4 p-2">
      <svg
        viewBox={`${-SIZE / 2} ${-SIZE / 2} ${SIZE} ${SIZE}`}
        className="h-full max-h-[240px] w-auto shrink-0"
        role="img"
        aria-label={`Run shape: ${total(counts)} steps, ${counts.passed} passed, ${counts.failed} failed`}
      >
        {arcs.map((arc) => {
          const ring = RINGS[arc.ring];
          const isSelected = samePath(selected, arc.path);
          const dimmed = hovered !== null && hovered.label !== arc.label;
          return (
            <path
              key={`${arc.ring}:${arc.path.member}:${arc.path.node ?? ""}:${arc.path.row ?? ""}`}
              d={arcPath(arc, ring.inner, ring.outer)}
              fill={CHART_FILL[arc.verdict]}
              stroke={isSelected ? "hsl(var(--foreground))" : "hsl(var(--card))"}
              strokeWidth={isSelected ? 2 : 1}
              opacity={dimmed ? 0.5 : 1}
              cursor="pointer"
              onClick={() => onSelect(arc.path)}
              onMouseEnter={() => setHovered(arc)}
              onMouseLeave={() => setHovered(null)}
            >
              {/* Thin arcs cannot hold text — below LABEL_MIN_DEGREES the hover layer *is*
                  the label, which is the selective-labelling rule rather than a shortcut. */}
              <title>{`${arc.label} — ${VERDICT_ICON[arc.verdict]} ${arc.verdict}`}</title>
            </path>
          );
        })}
        <text textAnchor="middle" className="fill-foreground" style={{ fontSize: 14, fontWeight: 500 }}>
          {counts.passed}/{ran(counts)}
        </text>
        <text y={13} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: 9 }}>
          steps passed
        </text>
      </svg>

      <div className="min-w-0 flex-1 text-[11px]">
        {hovered ? (
          <>
            <div className="truncate font-medium text-foreground">{hovered.label}</div>
            <div className="text-muted-foreground">
              {VERDICT_ICON[hovered.verdict]} {hovered.verdict} · {RING_NAMES[hovered.ring]}
            </div>
          </>
        ) : (
          <div className="text-muted-foreground">
            Hover an arc to name it. Rings go outward: members, their steps, then each
            step&apos;s data rows.
          </div>
        )}
        <ul className="mt-2 space-y-0.5 text-[10px] text-muted-foreground">
          {RING_NAMES.map((name, i) => (
            <li key={name} className="flex items-center gap-1.5">
              <span className="tabular-nums opacity-60">ring {i + 1}</span>
              <span>{name}</span>
              <span className="tabular-nums opacity-60">
                {arcs.filter((a) => a.ring === i).length}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-1 text-[10px] text-muted-foreground/70">
          {LABEL_MIN_DEGREES}° is the narrowest arc that could hold a label, so none are
          printed — hover instead.
        </p>
      </div>
    </div>
  );
};

export default RunChart;
