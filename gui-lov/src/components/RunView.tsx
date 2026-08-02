import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Layers, Workflow, Loader2 } from "lucide-react";
import { runsApi } from "@/lib/api";
import type { FlowRun, SuiteRun, TestCaseExecutionResult } from "@/lib/api/types";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ResizablePanel, ResizablePanelGroup, ResizableHandle } from "@/components/ui/resizable";
import { SingleResultView, DatasetResultView } from "@/components/TestCaseEditor";
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

  const toggle = (path: TreePath) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      const key = pathKey(path);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const chosen = selected ? resultAt(run, selected) : undefined;
  const v = verdict(run);

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
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel defaultSize={38} minSize={22}>
            <ScrollArea className="h-full">
              <div className="p-2 font-mono text-xs">
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
                  {/* A fan-out aggregate selected at node level gets the row matrix the
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
      </div>

      <div className="flex items-center gap-3 border-t border-border px-4 py-1.5 text-xs">
        <span className={verdictClass[v]}>{countsLine(run)}</span>
        <div className="flex-1" />
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
        onClick={() => onToggle(path)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-muted/20"
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
