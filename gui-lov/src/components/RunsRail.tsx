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
 * Two lines, and a deliberately small set of facts on them.
 *
 * The full row from `RunHistory` — duration, when, "35/49 passed · 14 failed", an ad-hoc
 * pill — does not fit in this column at any font size. The first attempt kept them all and
 * clipped mid-word: `35/49 passed · 14 fa`, which is worse than dropping them, because a
 * fact you cannot finish reading still spends the space.
 *
 * So the row keeps what you pick a run *by*: the verdict, the name, how much passed, and
 * when. The failure breakdown is in the tooltip and in the full history — one click away,
 * and this list is for finding a run rather than for reading one.
 */
const RunRow = ({ run, onOpen }: { run: SuiteRun; onOpen: () => void }) => {
  const v = verdict(run);
  const ran = run.total - run.skipped;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${run.suite_name} — ${countsLine(run)}${run.suite_id ? "" : " (ad-hoc flow run)"}`}
      className="flex w-full items-start gap-1.5 rounded px-1.5 py-1 text-left hover:bg-sidebar-accent"
    >
      <span className={`mt-[2px] w-3 shrink-0 text-center font-mono text-xs ${verdictClass[v]}`}>
        {verdictIcon(v)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[13px] leading-tight">
            {run.suite_name}
          </span>
          {/* Bare numbers, no words: "passed" spelled out is what pushed the name off the
              row, and the icon beside it has already said which way it went. */}
          {ran > 0 && (
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {run.passed}/{ran}
            </span>
          )}
        </span>
        <span className="mt-0.5 flex items-baseline gap-1.5 text-[10px] text-muted-foreground">
          <span className="truncate">{formatWhen(run.started_at)}</span>
          <span className="shrink-0 tabular-nums">{formatDuration(run.duration_ms)}</span>
          {/* A flow someone ran by hand, not a suite. In words rather than a pill: a badge on
              every second row is what makes a narrow column unreadable. */}
          {!run.suite_id && <span className="shrink-0">· ad-hoc</span>}
        </span>
      </span>
    </button>
  );
};

export default RunsRail;
