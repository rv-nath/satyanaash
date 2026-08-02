import { useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { History, Trash2, RefreshCw } from "lucide-react";
import { runsApi } from "@/lib/api";
import type { SuiteRun } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import {
  countsLine,
  formatDuration,
  formatWhen,
  verdict,
  verdictIcon,
  type RunVerdict,
} from "@/lib/runHistory";

/**
 * The index of every run. Not a viewer — clicking a row opens it in its own tab.
 *
 * A suite is a template and a run is an instance, so a run is a thing you open. This
 * screen exists to find one.
 *
 * Runs of a single flow started by hand are hidden by default. Running a flow is how you
 * author one, and twenty of those would push last night's suite run off the first screen
 * — but they are counted out loud, because silently omitting them would read as "that's
 * all there is".
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
}

const RunHistory = ({ projectId, onOpenRun }: Props) => {
  const [includeAdhoc, setIncludeAdhoc] = useState(false);
  const queryClient = useQueryClient();

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["runs", projectId, includeAdhoc],
    queryFn: () => runsApi.list(projectId, { includeAdhoc }),
    // A run in flight does not push to this list, so a stale headline is expected. It
    // refetches on open and on demand rather than polling — the run tab is where you
    // watch a run happen.
    staleTime: 10_000,
  });

  const runs = data?.runs ?? [];
  const hidden = data?.adhoc_hidden ?? 0;

  const remove = useMutation({
    mutationFn: (id: string) => runsApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["runs", projectId] });
      toast.success("Run deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2">
        <History className="h-4 w-4 shrink-0 text-primary" />
        <span className="text-sm font-medium">Runs</span>
        <span className="text-xs text-muted-foreground">{runs.length}</span>
        <div className="flex-1" />
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox
            checked={includeAdhoc}
            onCheckedChange={(checked) => setIncludeAdhoc(checked === true)}
            aria-label="Show ad-hoc flow runs"
          />
          Show ad-hoc flow runs
        </label>
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
      </div>

      <ScrollArea className="flex-1">
        {isLoading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : runs.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {hidden > 0
              ? `No suite runs yet — ${hidden} ad-hoc flow ${hidden === 1 ? "run" : "runs"} are hidden.`
              : "No runs yet. Run a suite and it appears here."}
          </p>
        ) : (
          <ul className="divide-y divide-border/50">
            {runs.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                onOpen={() => onOpenRun(run.id)}
                onDelete={() => remove.mutate(run.id)}
              />
            ))}
          </ul>
        )}

        {hidden > 0 && runs.length > 0 && (
          <p className="px-4 py-3 text-xs text-muted-foreground/70">
            … {hidden} ad-hoc flow {hidden === 1 ? "run" : "runs"} hidden
          </p>
        )}
      </ScrollArea>
    </div>
  );
};

const RunRow = ({
  run,
  onOpen,
  onDelete,
}: {
  run: SuiteRun;
  onOpen: () => void;
  onDelete: () => void;
}) => {
  const v = verdict(run);
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => e.key === "Enter" && onOpen()}
        title="Open this run"
        className="group flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-left hover:bg-muted/30"
      >
        <span className={`w-3 shrink-0 font-mono text-sm ${verdictClass[v]}`}>
          {verdictIcon(v)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{run.suite_name}</span>
        {/* An ad-hoc run says so: it is a flow you ran by hand, not a suite. */}
        {!run.suite_id && (
          <span className="shrink-0 rounded bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            ad-hoc
          </span>
        )}
        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
          {countsLine(run)}
        </span>
        <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {formatDuration(run.duration_ms)}
        </span>
        <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">
          {formatWhen(run.started_at)}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 shrink-0 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete this run"
          aria-label={`Delete run ${run.suite_name}`}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    </li>
  );
};

export default RunHistory;
