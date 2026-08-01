import { useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { History, Trash2, RefreshCw, ChevronRight, ChevronDown } from "lucide-react";
import { runsApi } from "@/lib/api";
import type { FlowRun, SuiteRun, TestCaseExecutionResult } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  countsLine,
  detailsFor,
  formatDuration,
  formatWhen,
  nodeTitle,
  runSubtitle,
  verdict,
  verdictIcon,
  type RunVerdict,
} from "@/lib/runHistory";
import {
  resultHeadline,
  detailSummary,
  worthFolding,
  type ConsoleLogDetail,
} from "@/lib/consoleDetails";

/**
 * Run history: every press of Run, kept.
 *
 * A stored run is rendered by the console's own functions — `resultHeadline`,
 * `resultDetails`, `fanOutDetails` — because a run from last Tuesday should read exactly
 * like the one in front of you. Anything that formatted history differently would be a
 * second dialect of the same information.
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
}

const RunHistory = ({ projectId }: Props) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: runs = [], isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["runs", projectId],
    queryFn: () => runsApi.list(projectId),
    // A run in flight will not push to this list, so a stale headline is expected. It is
    // refetched on open and on demand rather than polled — the console is where you watch
    // a run happen.
    staleTime: 10_000,
  });

  const { data: run } = useQuery({
    queryKey: ["run", selectedId],
    queryFn: () => runsApi.get(selectedId!),
    enabled: !!selectedId,
  });

  const remove = useMutation({
    mutationFn: (id: string) => runsApi.delete(id),
    onSuccess: (_data, id) => {
      if (selectedId === id) setSelectedId(null);
      queryClient.invalidateQueries({ queryKey: ["runs", projectId] });
      toast.success("Run deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="flex h-full">
      <div className="flex w-[340px] shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">Runs</span>
            <span className="text-xs text-muted-foreground">{runs.length}</span>
          </div>
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
            <p className="p-4 text-xs text-muted-foreground">Loading…</p>
          ) : runs.length === 0 ? (
            <p className="p-4 text-xs text-muted-foreground">
              No runs yet. Every flow and suite you run is kept here — including the ones
              you ran by hand.
            </p>
          ) : (
            <ul className="divide-y divide-border/50">
              {runs.map((r) => (
                <RunRow
                  key={r.id}
                  run={r}
                  selected={r.id === selectedId}
                  onSelect={() => setSelectedId(r.id)}
                  onDelete={() => remove.mutate(r.id)}
                />
              ))}
            </ul>
          )}
        </ScrollArea>
      </div>

      <div className="min-w-0 flex-1">
        {!selectedId ? (
          <p className="p-6 text-sm text-muted-foreground">
            Pick a run to see what it did.
          </p>
        ) : !run ? (
          <p className="p-6 text-sm text-muted-foreground">Loading run…</p>
        ) : (
          <RunDetail run={run} />
        )}
      </div>
    </div>
  );
};

const RunRow = ({
  run,
  selected,
  onSelect,
  onDelete,
}: {
  run: SuiteRun;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) => {
  const v = verdict(run);
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => e.key === "Enter" && onSelect()}
        className={`group flex w-full cursor-pointer items-start gap-2 px-3 py-2 text-left hover:bg-muted/30 ${
          selected ? "bg-primary/10" : ""
        }`}
      >
        <span className={`mt-0.5 w-3 shrink-0 font-mono text-sm ${verdictClass[v]}`}>
          {verdictIcon(v)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm">{run.suite_name}</span>
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {formatWhen(run.started_at)}
            </span>
          </div>
          <div className="truncate text-xs text-muted-foreground">{countsLine(run)}</div>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground/70">
            <span>{formatDuration(run.duration_ms)}</span>
            {run.environment_name && <span>· {run.environment_name}</span>}
          </div>
        </div>
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

const RunDetail = ({ run }: { run: SuiteRun }) => {
  const v = verdict(run);
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className={`font-mono text-lg ${verdictClass[v]}`}>{verdictIcon(v)}</span>
          <h2 className="truncate text-base font-medium">{run.suite_name}</h2>
          <span className="text-xs text-muted-foreground">{runSubtitle(run)}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{countsLine(run)}</span>
          <span>· {formatDuration(run.duration_ms)}</span>
          <span>· {formatWhen(run.started_at)}</span>
          {run.environment_name && <span>· {run.environment_name}</span>}
        </div>
        {run.error_message && (
          <p className="mt-2 text-xs text-destructive">{run.error_message}</p>
        )}
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-3 p-4">
          {(run.members ?? []).map((member) => (
            <MemberBlock key={member.id} member={member} />
          ))}
          {(run.members ?? []).length === 0 && (
            <p className="text-xs text-muted-foreground">
              This run recorded no members. If it says “running”, the server stopped before
              it finished one.
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

const MemberBlock = ({ member }: { member: FlowRun }) => {
  const [open, setOpen] = useState(true);
  const results = member.results ?? [];

  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/20"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <span className="truncate text-sm">{member.name}</span>
        <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
          {member.member_kind}
        </span>
        {/* The link is dropped when a flow is deleted, but the record is not — saying so
            stops the missing link reading as a bug. */}
        {member.member_kind === "flow" && !member.flow_id && (
          <span className="shrink-0 text-[10px] text-muted-foreground/70" title="The flow has since been deleted">
            (deleted)
          </span>
        )}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {formatDuration(member.duration_ms)}
        </span>
      </button>

      {open && (
        <div className="space-y-1 border-t border-border/50 p-2 font-mono text-xs">
          {results.length === 0 && (
            <p className="px-2 text-muted-foreground">No node results recorded.</p>
          )}
          {results.map((result, i) => (
            <NodeBlock key={`${result.node_id}-${i}`} result={result} />
          ))}
        </div>
      )}
    </div>
  );
};

/** One node, rendered by the console's functions so a stored run reads like a live one. */
const NodeBlock = ({ result }: { result: TestCaseExecutionResult }) => {
  const [open, setOpen] = useState(false);
  const headline = resultHeadline(result, nodeTitle(result));
  const details = detailsFor(result);
  const problem = result.status === "failed" || result.status === "error";

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-start gap-2 rounded px-2 py-1 text-left hover:bg-muted/20"
      >
        <span className="mt-0.5 w-3 shrink-0 text-muted-foreground">
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </span>
        <span className={`min-w-0 flex-1 whitespace-pre-wrap ${problem ? "text-destructive" : ""}`}>
          {headline}
        </span>
      </button>
      {open && (
        <div className="ml-8 space-y-1 border-l border-border/50 pl-3">
          {details.map((detail, i) => (
            <DetailRow key={i} detail={detail} />
          ))}
        </div>
      )}
    </div>
  );
};

/** Mirrors the console's own DetailRow: a row with a verdict folds whatever its size, so
 *  a column of dataset rows stays a column. */
const DetailRow = ({ detail }: { detail: ConsoleLogDetail }) => {
  const foldable = detail.note !== undefined || worthFolding(detail.value);
  const [open, setOpen] = useState(!foldable);
  const colorClass = detail.type === "error" ? "text-destructive" : "text-console-text";

  const body = (
    <pre className={`${colorClass} mt-1 whitespace-pre-wrap break-all rounded bg-muted/10 px-2 py-1`}>
      {detail.value}
    </pre>
  );

  if (!foldable) {
    return (
      <div className="py-0.5">
        <span className="text-muted-foreground">{detail.label}: </span>
        {detail.value.includes("\n") ? body : <span className={colorClass}>{detail.value}</span>}
      </div>
    );
  }

  return (
    <div className="py-0.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1 rounded text-left hover:bg-muted/10"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <span
          className={`whitespace-pre ${detail.type === "error" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {detail.label}
        </span>
        <span
          className={`whitespace-pre ${detail.note !== undefined ? "text-console-text" : "text-muted-foreground/60"}`}
        >
          {detail.note ?? detailSummary(detail.value)}
        </span>
      </button>
      {open && body}
    </div>
  );
};

export default RunHistory;
