import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChevronLeft } from "lucide-react";
import type { SuiteRun } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/runHistory";
import { samePath, type TreePath } from "@/lib/runTree";
import {
  arcPath,
  breakdownAt,
  CHART_FILL,
  CHART_VIEWS,
  LABEL_MIN_DEGREES,
  memberSeries,
  ran,
  runCounts,
  slowestSteps,
  sunburstArcs,
  total,
  VERDICT_ICON,
  VERDICTS,
  type RunChartView,
  type Verdict,
} from "@/lib/runCharts";

/**
 * A run as a picture, with the tree beside it.
 *
 * Four presentations named by the question they answer, not by their geometry. Clicking
 * any mark reports a `TreePath` — the same selection the tree uses — so the two are one
 * state and the chart is a drill-down rather than a decoration.
 *
 * Fills come from `CHART_FILL`, which is re-stepped from the app's status hues and
 * validated: the theme's own green and red are ΔE 5.2 apart under deuteranopia, i.e.
 * indistinguishable. The tree survives that because ✓ and ✗ carry the meaning; a stacked
 * bar has no such help, which is why every legend entry and tooltip here carries its icon.
 */
interface Props {
  run: SuiteRun;
  view: RunChartView;
  onViewChange: (view: RunChartView) => void;
  selected: TreePath | null;
  onSelect: (path: TreePath) => void;
}

const RunChart = ({ run, view, onViewChange, selected, onSelect }: Props) => {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
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
        <Legend />
      </div>

      <div className="min-h-0 flex-1">
        {view === "profile" && <Profile run={run} selected={selected} onSelect={onSelect} />}
        {view === "breakdown" && <Breakdown run={run} onSelect={onSelect} />}
        {view === "slowest" && <Slowest run={run} selected={selected} onSelect={onSelect} />}
        {view === "hierarchy" && <Hierarchy run={run} selected={selected} onSelect={onSelect} />}
      </div>
    </div>
  );
};

/** Always present, and every entry carries its mark — status is never colour alone. */
const Legend = () => (
  <div className="flex items-center gap-2.5 text-[10px] text-muted-foreground">
    {VERDICTS.map((v) => (
      <span key={v} className="flex items-center gap-1">
        <span
          className="inline-block h-2 w-2 rounded-sm"
          style={{ background: CHART_FILL[v] }}
          aria-hidden
        />
        <span aria-hidden>{VERDICT_ICON[v]}</span>
        {v}
      </span>
    ))}
  </div>
);

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="p-4 text-xs text-muted-foreground">{children}</p>
);

/** Shared tooltip shell — Recharts' default is unstyled and unthemed. */
const Box = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded border border-border bg-card px-2 py-1 text-xs shadow-md">{children}</div>
);

// ---------------------------------------------------------------- Profile

const Profile = ({
  run,
  selected,
  onSelect,
}: {
  run: SuiteRun;
  selected: TreePath | null;
  onSelect: (p: TreePath) => void;
}) => {
  const bars = useMemo(() => memberSeries(run), [run]);
  if (bars.length === 0) return <Empty>Nothing has run yet.</Empty>;

  const counts = runCounts(run);
  // Height per bar rather than a fixed chart height: seventeen members squeezed into
  // 200px is a smear.
  const height = Math.max(bars.length * 22 + 28, 120);

  return (
    <div className="h-full overflow-y-auto px-2 py-1">
      <p className="px-2 pb-1 text-[10px] text-muted-foreground">
        {total(counts)} nodes · one bar per member, in run order
      </p>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={bars} layout="vertical" barSize={12} margin={{ left: 4, right: 24 }}>
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="name"
            width={150}
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: "hsl(var(--muted) / 0.3)" }}
            content={({ payload }) => {
              const bar = payload?.[0]?.payload as (typeof bars)[number] | undefined;
              if (!bar) return null;
              return (
                <Box>
                  <div className="font-medium">{bar.name}</div>
                  {bar.empty ? (
                    <div className="text-warning">nothing ran</div>
                  ) : (
                    <div className="text-muted-foreground">
                      {bar.passed}/{ran(bar)} passed
                      {bar.rows > 0 && ` · ${bar.rows} rows underneath`}
                    </div>
                  )}
                  <div className="text-muted-foreground">{formatDuration(bar.durationMs)}</div>
                </Box>
              );
            }}
          />
          {VERDICTS.map((v) => (
            <Bar key={v} dataKey={v} stackId="a" fill={CHART_FILL[v]} isAnimationActive={false}>
              {bars.map((bar, i) => (
                // A 2px surface gap between segments, and an outline on the selected bar.
                <Cell
                  key={i}
                  cursor="pointer"
                  stroke={samePath(selected, bar.path) ? "hsl(var(--foreground))" : "hsl(var(--card))"}
                  strokeWidth={samePath(selected, bar.path) ? 1.5 : 2}
                  onClick={() => onSelect(bar.path)}
                />
              ))}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>

      {/* Said in the open rather than left as an absent bar — a member that ran nothing is
          how a suite reports coverage it does not have. */}
      {bars.some((b) => b.empty) && (
        <p className="px-2 pt-1 text-[10px] text-warning">
          {bars.filter((b) => b.empty).map((b) => b.name).join(", ")} — nothing ran
        </p>
      )}
    </div>
  );
};

// ---------------------------------------------------------------- Breakdown

const Breakdown = ({ run, onSelect }: { run: SuiteRun; onSelect: (p: TreePath) => void }) => {
  // Its own drill state: where you are *looking* is not the same as what you have
  // selected, and collapsing them would move the detail pane every time you opened a ring.
  const [at, setAt] = useState<TreePath | null>(null);
  const level = useMemo(() => breakdownAt(run, at), [run, at]);

  if (level.slices.length === 0) return <Empty>Nothing to break down yet.</Empty>;

  const crumbs = ["Run"];
  if (at) {
    crumbs.push(run.members?.[at.member]?.name ?? "member");
    if (at.node !== undefined) {
      crumbs.push(run.members?.[at.member]?.results?.[at.node]?.test_case_name ?? "step");
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-3 pt-1 text-[10px] text-muted-foreground">
        {at && (
          <Button
            variant="ghost"
            size="icon"
            className="h-4 w-4"
            onClick={() => setAt(at.node === undefined ? null : { member: at.member })}
            aria-label="Back"
          >
            <ChevronLeft className="h-3 w-3" />
          </Button>
        )}
        <span>{crumbs.join(" / ")}</span>
        {/* The unit, always. This is the level at which the headline's "0 skipped" turns
            out to have meant "0 nodes skipped". */}
        <span className="ml-auto">
          {level.slices.length} {level.unit}
          {level.counts.skipped > 0 && ` · ${level.counts.skipped} skipped`}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={level.slices}
              dataKey="value"
              nameKey="label"
              innerRadius="45%"
              outerRadius="78%"
              paddingAngle={2}
              isAnimationActive={false}
            >
              {level.slices.map((slice, i) => (
                <Cell
                  key={i}
                  fill={CHART_FILL[slice.verdict]}
                  stroke="hsl(var(--card))"
                  strokeWidth={2}
                  cursor="pointer"
                  onClick={() => {
                    onSelect(slice.path);
                    if (slice.drillable) setAt(slice.path);
                  }}
                />
              ))}
            </Pie>
            <Tooltip
              content={({ payload }) => {
                const slice = payload?.[0]?.payload as (typeof level.slices)[number] | undefined;
                if (!slice) return null;
                return (
                  <Box>
                    <div className="font-medium">{slice.label}</div>
                    <div className="text-muted-foreground">
                      {VERDICT_ICON[slice.verdict]} {slice.verdict}
                      {slice.drillable && " · click to open"}
                    </div>
                  </Box>
                );
              }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
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
  if (steps.length === 0) return <Empty>No step has taken measurable time yet.</Empty>;

  const height = Math.max(steps.length * 22 + 28, 120);

  return (
    <div className="h-full overflow-y-auto px-2 py-1">
      <p className="px-2 pb-1 text-[10px] text-muted-foreground">
        slowest {steps.length} steps · {formatDuration(run.duration_ms)} for the whole run
      </p>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={steps} layout="vertical" barSize={12} margin={{ left: 4, right: 48 }}>
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="label"
            width={160}
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
                  {/* Which member it came from. Four `Reset Password` bars are
                      meaningless without it. */}
                  <div className="text-muted-foreground">in {step.member}</div>
                  <div className="text-muted-foreground">
                    {formatDuration(step.ms)} · {VERDICT_ICON[step.verdict]} {step.verdict}
                  </div>
                </Box>
              );
            }}
          />
          <Bar dataKey="ms" isAnimationActive={false} radius={[0, 4, 4, 0]}>
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

const SIZE = 260;
const RINGS = [
  { inner: 34, outer: 62 },
  { inner: 64, outer: 92 },
  { inner: 94, outer: 118 },
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
  const [hovered, setHovered] = useState<string | null>(null);
  if (arcs.length === 0) return <Empty>Nothing has run yet.</Empty>;

  const counts = runCounts(run);

  return (
    <div className="flex h-full items-center justify-center gap-4 p-2">
      <svg
        viewBox={`${-SIZE / 2} ${-SIZE / 2} ${SIZE} ${SIZE}`}
        className="h-full max-h-[260px] w-auto"
        role="img"
        aria-label={`Run shape: ${total(counts)} nodes, ${counts.passed} passed, ${counts.failed} failed`}
      >
        {arcs.map((arc) => {
          const ring = RINGS[arc.ring];
          const wide = arc.endAngle - arc.startAngle >= LABEL_MIN_DEGREES;
          const isSelected = samePath(selected, arc.path);
          return (
            <path
              key={`${arc.ring}:${arc.path.member}:${arc.path.node ?? ""}:${arc.path.row ?? ""}`}
              d={arcPath(arc, ring.inner, ring.outer)}
              fill={CHART_FILL[arc.verdict]}
              stroke={isSelected ? "hsl(var(--foreground))" : "hsl(var(--card))"}
              strokeWidth={isSelected ? 2 : 1}
              opacity={hovered === null || hovered === arc.label ? 1 : 0.55}
              cursor="pointer"
              onClick={() => onSelect(arc.path)}
              onMouseEnter={() => setHovered(arc.label)}
              onMouseLeave={() => setHovered(null)}
            >
              {/* Thin arcs cannot hold text, so every arc carries its name here — the
                  hover layer is the label for the ones too narrow to print. */}
              <title>{`${arc.label} — ${VERDICT_ICON[arc.verdict]} ${arc.verdict}${wide ? "" : ""}`}</title>
            </path>
          );
        })}
        <text
          textAnchor="middle"
          className="fill-foreground"
          style={{ fontSize: 13, fontWeight: 500 }}
        >
          {counts.passed}/{ran(counts)}
        </text>
        <text
          y={14}
          textAnchor="middle"
          className="fill-muted-foreground"
          style={{ fontSize: 9 }}
        >
          nodes passed
        </text>
      </svg>

      <div className="max-w-[40%] text-[10px] text-muted-foreground">
        <div className="mb-1 font-medium text-foreground">
          {hovered ?? "member · step · row"}
        </div>
        <p>Rings go outward: members, their steps, then each step&apos;s data rows.</p>
        <p className="mt-1">Click any arc to open it beside the tree.</p>
      </div>
    </div>
  );
};

export default RunChart;
