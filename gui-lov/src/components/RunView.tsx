import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Layers, Workflow, Loader2 } from "lucide-react";
import { runsApi } from "@/lib/api";
import type { FlowRun, SuiteRun, TestCaseExecutionResult } from "@/lib/api/types";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ResizablePanel, ResizablePanelGroup, ResizableHandle } from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";
import { SingleResultView, DatasetResultView } from "@/components/TestCaseEditor";
import RunChart from "@/components/RunChart";
import { CHART_VIEWS, DEFAULT_VIEW, rowsNote, type RunChartView } from "@/lib/runCharts";
import { liveRunToSuiteRun, progressLine, type LiveRun } from "@/lib/liveRun";
import {
  breadcrumb,
  initiallyExpanded,
  pathKey,
  resultAt,
  rowSummary,
  samePath,
  type TreePath,
} from "@/lib/runTree";
import {
  countsLine,
  formatDuration,
  formatWhen,
  nodeTitle,
  verdict,
  verdictIcon,
  type RunVerdict,
} from "@/lib/runHistory";

/**
 * A run, read as a report rather than as a log.
 *
 * The tree on the left is the whole run at a glance — run, member, node, row, the four
 * levels the schema has. The pane on the right is whatever is selected, rendered by
 * `SingleResultView`, the same component the test editor uses. Nothing here renders a
 * result a second way.
 *
 * A run in flight and a run from last Tuesday take the same path: `liveRunToSuiteRun`
 * gives the stream the shape the API returns, so the report does not change appearance
 * the moment the last member finishes.
 */
/**
 * The chosen presentation, remembered per project.
 *
 * You have a question you keep asking, so the view you picked is the view the next run
 * opens on. Per project rather than globally: a project's suites have their own shape.
 * Same localStorage habit as the active environment and console visibility.
 */
function useChartView(projectId: string): [RunChartView, (v: RunChartView) => void] {
  const key = `sat.runChart.view.${projectId}`;
  const [view, setView] = useState<RunChartView>(() => {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    // Validated against the current list, not trusted: anyone who used the chart before
    // `Profile` was dropped has its name in storage, and an unknown view would render a
    // blank panel with no clue why.
    return CHART_VIEWS.some((v) => v.id === stored) ? (stored as RunChartView) : DEFAULT_VIEW;
  });
  return [
    view,
    (next) => {
      setView(next);
      try {
        localStorage.setItem(key, next);
      } catch {
        // A browser refusing storage is not a reason to refuse the click.
      }
    },
  ];
}

/** Whether the chart panel is showing. Not per project — it is about how much room you
 *  want, which does not change when you switch project. */
function useChartOpen(): [boolean, (open: boolean) => void] {
  const key = 'sat.runChart.open';
  const [open, setOpen] = useState(
    () => (typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null) !== 'false',
  );
  return [
    open,
    (next) => {
      setOpen(next);
      try {
        localStorage.setItem(key, String(next));
      } catch {
        // ignored, as above
      }
    },
  ];
}

const verdictClass: Record<RunVerdict, string> = {
  passed: "text-success",
  failed: "text-destructive",
  error: "text-destructive",
  stopped: "text-muted-foreground",
  running: "text-primary",
};

const statusMark = (status: string): { icon: string; cls: string } => {
  if (status === "passed") return { icon: "✓", cls: "text-success" };
  if (status === "failed" || status === "error") return { icon: "✗", cls: "text-destructive" };
  if (status === "running") return { icon: "…", cls: "text-primary" };
  return { icon: "○", cls: "text-muted-foreground" };
};

interface Props {
  runId: string;
  /** The run in flight, when it is this one. Preferred over the stored copy: the database
   *  only gains a member when that member finishes, which can be minutes. */
  liveRun?: LiveRun | null;
}

const RunView = ({ runId, liveRun }: Props) => {
  const isLive = liveRun?.runId === runId;

  const { data: stored, isLoading } = useQuery({
    queryKey: ["run", runId],
    queryFn: () => runsApi.get(runId),
    // While the stream is feeding this view there is nothing to fetch; once it ends the
    // stored copy takes over and carries the server's own durations and timestamps.
    enabled: !isLive || liveRun?.status !== undefined,
    refetchOnWindowFocus: false,
  });

  const run: SuiteRun | undefined = useMemo(() => {
    if (isLive && liveRun && (!stored || !liveRun.status)) return liveRunToSuiteRun(liveRun);
    return stored;
  }, [isLive, liveRun, stored]);

  if (!run) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        {isLoading ? "Loading run…" : "This run is no longer here."}
      </p>
    );
  }

  return <RunReport run={run} live={isLive ? liveRun ?? null : null} />;
};

const RunReport = ({ run, live }: { run: SuiteRun; live: LiveRun | null }) => {
  // Seeded once from the run as first seen. Re-deriving on every event would slam
  // branches shut under the reader as a live run grows.
  const [expanded, setExpanded] = useState(() => initiallyExpanded(run));
  const [selected, setSelected] = useState<TreePath | null>(null);
  const [wordWrap, setWordWrap] = useState(true);
  const [rowInNode, setRowInNode] = useState<number | null>(null);
  const [chartView, setChartView] = useChartView(run.project_id);
  const [chartOpen, setChartOpen] = useChartOpen();
  const treeRef = useRef<HTMLDivElement>(null);

  const toggle = (path: TreePath) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      const key = pathKey(path);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  // The chart and the tree are one selection, not two. Clicking a mark also opens the
  // branch it lives in, or the tree would highlight something the reader cannot see.
  const selectFromChart = (path: TreePath) => {
    setSelected(path);
    setRowInNode(path.row ?? null);
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(pathKey({ member: path.member }));
      if (path.node !== undefined) next.add(pathKey({ member: path.member, node: path.node }));
      return next;
    });
  };

  const chosen = selected ? resultAt(run, selected) : undefined;
  const v = verdict(run);

  /**
   * Bring the selected row into view.
   *
   * Selecting from the chart moved the detail pane and highlighted a tree row that could be
   * fifty rows down — so the highlight was somewhere off-screen and the tree looked like it
   * had ignored the click.
   *
   * Runs after the render that expands the branch, because the row does not exist in the
   * DOM until then. `block: 'nearest'` so a row already on screen does not jolt the list.
   */
  useEffect(() => {
    if (!selected) return;
    const row = treeRef.current?.querySelector<HTMLElement>(
      `[data-treepath="${pathKey(selected)}"]`,
    );
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected, expanded]);

  const treeAndDetail = (
    <ResizablePanelGroup direction="horizontal">
      <ResizablePanel defaultSize={38} minSize={22}>
        <ScrollArea className="h-full">
          <div ref={treeRef} className="p-2 font-mono text-xs">
            {(run.members ?? []).map((member, m) => (
              <MemberBranch
                key={member.id}
                member={member}
                index={m}
                expanded={expanded}
                selected={selected}
                onToggle={toggle}
                onSelect={(path) => {
                  setSelected(path);
                  setRowInNode(null);
                }}
              />
            ))}
            {(run.members ?? []).length === 0 && (
              <p className="p-2 text-muted-foreground">Nothing has run yet.</p>
            )}
          </div>
        </ScrollArea>
      </ResizablePanel>

      <ResizableHandle />

      <ResizablePanel defaultSize={62} minSize={30}>
        {!chosen ? (
          <p className="p-6 text-sm text-muted-foreground">
            Pick a step to see what it sent and what came back.
          </p>
        ) : (
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-1 border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
              {breadcrumb(run, selected!).map((crumb, i, all) => (
                <span key={i} className={i === all.length - 1 ? "text-foreground" : undefined}>
                  {crumb}
                  {i < all.length - 1 && <span className="px-1 opacity-50">/</span>}
                </span>
              ))}
            </div>
            <div className="min-h-0 flex-1">
              {/* A fan-out aggregate selected at step level gets the row matrix the
                  dataset editor already uses; anything else is one request. */}
              {chosen.iterations ? (
                <DatasetResultView
                  aggregate={chosen}
                  selected={rowInNode}
                  onSelect={setRowInNode}
                  wordWrap={wordWrap}
                  setWordWrap={setWordWrap}
                  running={false}
                />
              ) : (
                <SingleResultView
                  result={chosen}
                  wordWrap={wordWrap}
                  setWordWrap={setWordWrap}
                  running={false}
                />
              )}
            </div>
          </div>
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-baseline gap-2 border-b border-border px-4 py-2">
        <span className={`font-mono text-base ${verdictClass[v]}`}>{verdictIcon(v)}</span>
        <h2 className="truncate text-sm font-medium">{run.suite_name}</h2>
        <span className="text-xs text-muted-foreground">{formatWhen(run.started_at)}</span>
        {run.environment_name && (
          <span className="text-xs text-muted-foreground">· {run.environment_name}</span>
        )}
        {live && !live.status && (
          <span className="flex items-center gap-1 text-xs text-primary">
            <Loader2 className="h-3 w-3 animate-spin" /> running
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {/* Two whole groups rather than one with a conditional panel.
            `react-resizable-panels` registers panels by walking its *direct* children, so
            wrapping a panel and its handle in a Fragment scrambled the order and the drag
            came out inverted — pulling the divider down grew the tree. */}
        {chartOpen ? (
          <ResizablePanelGroup direction="vertical">
            <ResizablePanel defaultSize={40} minSize={20}>
              <RunChart
                run={run}
                view={chartView}
                onViewChange={setChartView}
                selected={selected}
                onSelect={selectFromChart}
              />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={60} minSize={25}>
              {treeAndDetail}
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          treeAndDetail
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-border px-4 py-1.5 text-xs">
        <span className={verdictClass[v]}>{countsLine(run)}</span>
        {/* What the headline leaves out. `countsLine` reports the stored figures, which
            count steps, so a run whose rows were mostly skipped says nothing about them. */}
        {rowsNote(run) && <span className="text-muted-foreground">· {rowsNote(run)}</span>}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-1.5 text-[10px] text-muted-foreground"
          onClick={() => setChartOpen(!chartOpen)}
        >
          {chartOpen ? "Hide chart" : "Show chart"}
        </Button>
        {live && !live.status ? (
          <span className="text-primary">{progressLine(live)}</span>
        ) : (
          <span className="text-muted-foreground">
            {run.members?.length ?? 0} {run.members?.length === 1 ? "member" : "members"}
          </span>
        )}
        <span className="tabular-nums text-muted-foreground">
          {formatDuration(run.duration_ms)}
        </span>
      </div>
    </div>
  );
};


const MemberBranch = ({
  member,
  index,
  expanded,
  selected,
  onToggle,
  onSelect,
}: {
  member: FlowRun;
  index: number;
  expanded: Set<string>;
  selected: TreePath | null;
  onToggle: (path: TreePath) => void;
  onSelect: (path: TreePath) => void;
}) => {
  const path = { member: index };
  const open = expanded.has(pathKey(path));
  const mark = statusMark(member.status);

  return (
    <div>
      <button
        type="button"
        data-treepath={pathKey(path)}
        onClick={() => onToggle(path)}
        aria-expanded={open}
        // Highlighted when it is the selection, the same as a step row. Drilling to a
        // member in the chart used to expand its branch and mark nothing, so the tree
        // looked like it had ignored the click.
        className={`flex w-full items-center gap-1.5 rounded px-1 py-1 text-left ${
          samePath(selected, path) ? "bg-primary/15" : "hover:bg-muted/20"
        }`}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <span className={`w-3 shrink-0 ${mark.cls}`}>{mark.icon}</span>
        {member.member_kind === "flow" ? (
          <Workflow className="h-3 w-3 shrink-0 text-node-group" />
        ) : (
          <Layers className="h-3 w-3 shrink-0 text-primary" />
        )}
        <span className="min-w-0 flex-1 truncate">{member.name}</span>
        <span className="shrink-0 text-muted-foreground">
          {formatDuration(member.duration_ms)}
        </span>
      </button>

      {open && (
        <div className="ml-3 border-l border-border/40 pl-1">
          {(member.results ?? []).map((node, n) => (
            <NodeBranch
              key={`${node.node_id}-${n}`}
              node={node}
              path={{ member: index, node: n }}
              expanded={expanded}
              selected={selected}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
          {(member.results ?? []).length === 0 && (
            <p className="px-2 py-1 text-muted-foreground">no steps yet</p>
          )}
        </div>
      )}
    </div>
  );
};

const NodeBranch = ({
  node,
  path,
  expanded,
  selected,
  onToggle,
  onSelect,
}: {
  node: TestCaseExecutionResult;
  path: TreePath;
  expanded: Set<string>;
  selected: TreePath | null;
  onToggle: (path: TreePath) => void;
  onSelect: (path: TreePath) => void;
}) => {
  const rows = node.iterations;
  const open = expanded.has(pathKey(path));
  const mark = statusMark(node.status);
  const isSelected = samePath(selected, path);
  const summary = rowSummary(node);

  return (
    <div>
      <div
        data-treepath={pathKey(path)}
        className={`flex items-center gap-1.5 rounded px-1 py-0.5 ${
          isSelected ? "bg-primary/15" : "hover:bg-muted/20"
        }`}
      >
        {rows ? (
          <button
            type="button"
            onClick={() => onToggle(path)}
            aria-expanded={open}
            aria-label={open ? "Collapse rows" : "Expand rows"}
            className="shrink-0"
          >
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <button
          type="button"
          onClick={() => onSelect(path)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span className={`w-3 shrink-0 ${mark.cls}`}>{mark.icon}</span>
          <span className="min-w-0 flex-1 truncate">{nodeTitle(node)}</span>
          {node.teardown && (
            <span className="shrink-0 text-[10px] text-muted-foreground">teardown</span>
          )}
          <span className="shrink-0 text-muted-foreground">
            {summary ?? (node.response ? String(node.response.status) : "—")}
          </span>
        </button>
      </div>

      {rows && open && (
        <div className="ml-3 border-l border-border/40 pl-1">
          {rows.map((row, r) => {
            const rowPath = { ...path, row: r };
            const rowMark = statusMark(row.status);
            return (
              <button
                key={r}
                type="button"
                data-treepath={pathKey(rowPath)}
                onClick={() => onSelect(rowPath)}
                className={`flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left ${
                  samePath(selected, rowPath) ? "bg-primary/15" : "hover:bg-muted/20"
                }`}
              >
                <span className={`w-3 shrink-0 ${rowMark.cls}`}>{rowMark.icon}</span>
                <span className="w-6 shrink-0 tabular-nums text-muted-foreground">
                  {(row.row_index ?? r) + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">{row.row_label ?? "—"}</span>
                <span className="shrink-0 text-muted-foreground">
                  {row.response ? row.response.status : "—"}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default RunView;
