import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Maximize2, RefreshCw } from "lucide-react";
import { runsApi } from "@/lib/api";
import type { SuiteRun } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  countsLine,
  formatDuration,
  formatWhen,
  verdict,
  verdictIcon,
  type RunVerdict,
} from "@/lib/runHistory";

/**
 * Recent runs, narrow enough for the sidebar.
 *
 * Deliberately not a mode of `RunHistory`. That one is a wide comparison table — verdict,
 * name, ad-hoc badge, counts, duration, when and delete on one row, with the counts column
 * hidden below `sm` — and it cannot work in a 200px column. Two components sharing the
 * helpers in `lib/runHistory` beats one component with two layouts.
 *
 * The point of having it here at all: opening last night's run used to mean switching to a
 * full-screen tab and giving up the canvas you were reading. From the sidebar you keep both.
 * The wide view stays one click away rather than being replaced.
 */
const verdictClass: Record<RunVerdict, string> = {
  passed: "text-success",
  failed: "text-destructive",
  error: "text-destructive",
  stopped: "text-muted-foreground",
  running: "text-primary",
};

interface Props {
  projectId: string;
  onOpenRun: (runId: string) => void;
  /** Opens the full-width history tab, for comparing across runs. */
  onOpenFullHistory: () => void;
}

export const RunsRail = ({ projectId, onOpenRun, onOpenFullHistory }: Props) => {
  // Ad-hoc runs stay hidden here with no way to show them: the toggle belongs on the full
  // view, where there is room to say what is hidden and why. The count still says so.
  const [includeAdhoc] = useState(false);

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["runs", projectId, includeAdhoc],
    queryFn: () => runsApi.list(projectId, { includeAdhoc }),
    staleTime: 10_000,
  });

  const runs = data?.runs ?? [];
  const hidden = data?.adhoc_hidden ?? 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 items-center gap-2 border-b border-sidebar-border px-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Runs
        </span>
        <span className="text-[10px] text-muted-foreground/60">{runs.length}</span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => refetch()}
          title="Check for newer runs"
          aria-label="Refresh runs"
        >
          <RefreshCw className={`h-3 w-3 ${isRefetching ? "animate-spin" : ""}`} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onOpenFullHistory}
          title="Open the full history, for comparing runs"
          aria-label="Open full run history"
        >
          <Maximize2 className="h-3 w-3" />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-1">
          {isLoading ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">Loading…</p>
          ) : runs.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {hidden > 0
                ? `No suite runs yet — ${hidden} ad-hoc flow ${hidden === 1 ? "run" : "runs"} hidden.`
                : "No runs yet. Run a suite and it appears here."}
            </p>
          ) : (
            runs.map((run) => <RunRow key={run.id} run={run} onOpen={() => onOpenRun(run.id)} />)
          )}

          {/* Counted out loud, never silently omitted — the same rule the full view keeps. */}
          {hidden > 0 && runs.length > 0 && (
            <p className="px-2 py-2 text-[10px] text-muted-foreground/70">
              … {hidden} ad-hoc flow {hidden === 1 ? "run" : "runs"} hidden
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

/**
 * Two lines, because one will not fit.
 *
 * A suite name and four facts on a single row inside a 200px column truncates the name to
 * nothing — and the name is the only part you scan by.
 */
const RunRow = ({ run, onOpen }: { run: SuiteRun; onOpen: () => void }) => {
  const v = verdict(run);
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Open this run — ${countsLine(run)}`}
      className="flex w-full items-start gap-1.5 rounded px-1.5 py-1 text-left hover:bg-sidebar-accent"
    >
      <span className={`mt-[1px] w-3 shrink-0 font-mono text-xs ${verdictClass[v]}`}>
        {verdictIcon(v)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-tight">{run.suite_name}</span>
        <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
          {formatDuration(run.duration_ms)} · {formatWhen(run.started_at)} · {countsLine(run)}
          {/* A flow you ran by hand, not a suite. Said in words here rather than as a badge:
              a pill on every second row in a narrow column is what pushes the name out. */}
          {!run.suite_id && " · ad-hoc"}
        </span>
      </span>
    </button>
  );
};

export default RunsRail;
