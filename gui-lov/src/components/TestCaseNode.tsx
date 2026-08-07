import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { Info, Loader2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useTestProject } from "@/contexts/TestProjectContext";
import { useTestCases } from "@/hooks/useApi";
import { statusIcon } from "@/lib/consoleDetails";
import { exportLines } from "@/lib/executionDecor";
import { attemptsNote, humanDuration, pollTiming } from "@/lib/poll";
import { listName, walkBadge, type NodeConfig } from "@/lib/nodeConfig";

interface TestCaseNodeData {
  label: string;
  method: string;
  endpoint?: string;
  testCaseId?: string;  // Reference to the test case for live name resolution
  /** The author's name for this node. Two nodes may share one test case in
   *  different roles ("Login as new user" vs "Root login"); the alias is what
   *  distinguishes them. The test case name stays visible underneath. */
  alias?: string;
  config?: NodeConfig;
}

interface TestCaseNodeProps {
  /** React Flow passes the node's own id, which is how a result is looked up. */
  id: string;
  data: TestCaseNodeData;
}

/**
 * Fill for the verdict pip on the node's corner.
 *
 * Solid, with the token's own foreground. Hollow — a tick coloured on the card
 * background — read as a stray mark next to the node's coloured ring rather than as a
 * status. Skipped never ran, so it stays grey instead of claiming a verdict colour.
 */
const statusTone = (status: string) =>
  status === "passed"
    ? "bg-success text-success-foreground"
    : status === "failed" || status === "error"
      ? "bg-destructive text-destructive-foreground"
      : "bg-muted-foreground text-background";

const getMethodColor = (method: string) => {
  const colors: Record<string, string> = {
    GET: "bg-success/20 text-success border-success/40",
    POST: "bg-primary/20 text-primary border-primary/40",
    PUT: "bg-warning/20 text-warning border-warning/40",
    DELETE: "bg-destructive/20 text-destructive border-destructive/40",
    PATCH: "bg-accent/20 text-accent border-accent/40",
  };
  return colors[method] || "bg-muted";
};

export const TestCaseNode = memo(({ id, data }: TestCaseNodeProps) => {
  const { projectId, activeFlowId, nodeRuns, activeNodeId } = useTestProject();
  const { data: testCases } = useTestCases(projectId || '');

  // What this node did last time the flow ran, and whether it is running right now.
  const lastRun = activeFlowId ? nodeRuns[activeFlowId]?.[id] : undefined;
  const running = activeNodeId === id;
  const exports = exportLines(lastRun?.exports);
  const rows = lastRun?.iterations;

  // Resolve current name from test cases cache, fallback to stored label
  const currentTestCase = data.testCaseId
    ? testCases?.find(tc => tc.id === data.testCaseId)
    : null;
  const testCaseName = currentTestCase?.name || data.label;
  const alias = data.alias?.trim();
  // A node that overrides the expectation says so on the canvas: otherwise the
  // graph looks identical to one that doesn't, and a passing 402 reads as a bug.
  const check = data.config?.check?.trim();
  const teardown = data.config?.teardown === true;
  const forEachRow = data.config?.forEachRow === true;
  // A step that walks a list a previous one collected. Named after the list, because
  // "which list" is the only thing that distinguishes two of these on a canvas.
  const walksList = walkBadge(data.config);
  const chosenRows = data.config?.rowIds?.length;
  // A node that may ask the same question sixty times behaves differently enough that
  // reading the graph should say so — otherwise a step that can take two minutes looks
  // exactly like one that takes 40ms. An `until` is what makes it poll, in the engine and
  // therefore here.
  const until = data.config?.poll?.until?.trim();
  const pollTime = pollTiming(data.config?.poll);
  const displayLabel = alias || testCaseName;
  const displayMethod = currentTestCase?.method || data.method;
  const displayEndpoint = currentTestCase?.endpoint || data.endpoint;

  // Only the name sits on the node. Method and endpoint are one click away via the
  // info button — on hover they'd steal attention while you're reading the graph.
  return (
    <div
      className={`relative flex items-center gap-1.5 rounded-lg border-2 bg-card px-2.5 py-1.5 shadow-md transition-shadow min-w-[140px] max-w-[260px] hover:shadow-lg ${
        // Dashed: this node is lifted out of the chain and runs after it, so it
        // shouldn't read as another link in the sequence.
        teardown ? "border-dashed border-muted-foreground/50" : ""
      }`}
    >
      {/* Input handles - top and left only */}
      <Handle id="target-top" type="target" position={Position.Top} className="!bg-primary" />
      <Handle id="target-left" type="target" position={Position.Left} className="!bg-primary" />

      <Popover>
        <PopoverTrigger asChild>
          {/* nodrag keeps React Flow from starting a drag on this button */}
          <button
            type="button"
            aria-label="Request details"
            onClick={(e) => e.stopPropagation()}
            // Two quick clicks on the ⓘ mean "open, no, close again" — not "open the
            // test case", which is what a double-click anywhere else on the node does.
            onDoubleClick={(e) => e.stopPropagation()}
            className="nodrag shrink-0 rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-auto max-w-[380px] p-3">
          <p className="text-[13px] font-medium leading-snug">{displayLabel}</p>
          {alias && (
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              runs <span className="text-foreground">{testCaseName}</span>
            </p>
          )}
          {teardown && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Runs <span className="text-foreground">after the flow</span>, whatever
              happened — for cleanup. Skipped if the values it needs didn't come from
              this run.
            </p>
          )}
          {forEachRow && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Runs <span className="text-foreground">once per data row</span>
              {chosenRows === undefined ? " — every row" : ` — ${chosenRows} selected`}, each
              inheriting what earlier steps produced.
            </p>
          )}
          {walksList && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Runs <span className="text-foreground">once per item</span> in{" "}
              <span className="font-mono text-foreground">
                {listName(data.config?.forEach)}
              </span>
              , which an earlier step collected.
            </p>
          )}
          {until && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Asks again every{" "}
              <span className="text-foreground">{humanDuration(pollTime.intervalMs)}</span>{" "}
              for up to{" "}
              <span className="text-foreground">{humanDuration(pollTime.timeoutMs)}</span>,
              until <code className="font-mono text-foreground">{until}</code>
            </p>
          )}
          {check && (
            <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
              expects <span className="text-foreground">{check}</span>
            </p>
          )}
          <div className="mt-2 flex items-baseline gap-2">
            <span
              className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] font-semibold ${getMethodColor(displayMethod)}`}
            >
              {displayMethod}
            </span>
            {displayEndpoint && (
              <span className="break-all font-mono text-[11px] text-muted-foreground">
                {displayEndpoint}
              </span>
            )}
          </div>

          {/* What happened last time. The full request and response stay in the
              console, which already renders them per node — this is the verdict and
              what the node handed on to the rest of the flow. */}
          {(running || lastRun) && (
            <div className="mt-2 grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1 border-t border-border pt-2 text-[11px]">
              <span className="text-muted-foreground">Last run</span>
              {running ? (
                <span className="text-primary">running…</span>
              ) : (
                <span className={statusTone(lastRun!.status)}>
                  {statusIcon(lastRun!.status)} {lastRun!.status}
                  <span className="text-muted-foreground">
                    {" · "}
                    {attemptsNote(lastRun!.attempts, lastRun!.duration_ms) ??
                      `${lastRun!.duration_ms}ms`}
                  </span>
                  {rows && (
                    <span className="text-muted-foreground">
                      {" · "}
                      {rows.filter((r) => r.status === "passed").length}/
                      {rows.filter((r) => r.status !== "skipped").length} rows passed
                    </span>
                  )}
                </span>
              )}
              {exports.length > 0 && (
                <>
                  <span className="text-muted-foreground">Exported</span>
                  <span className="min-w-0">
                    {exports.map(({ name, value }) => (
                      <span key={name} className="block break-all font-mono text-foreground">
                        {name} = {value}
                      </span>
                    ))}
                  </span>
                </>
              )}
            </div>
          )}
        </PopoverContent>
      </Popover>

      {teardown && (
        <span
          className="shrink-0 rounded bg-muted px-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground"
          title="Runs at the end, after the flow — even if the flow failed"
        >
          cleanup
        </span>
      )}
      {forEachRow && (
        <span
          className="shrink-0 rounded border border-primary/40 bg-primary/10 px-1 font-mono text-[9px] font-semibold text-primary"
          title={
            chosenRows === undefined
              ? "Runs once per data row — every row"
              : `Runs once per data row — ${chosenRows} selected`
          }
        >
          {chosenRows === undefined ? "rows" : `${chosenRows} rows`}
        </span>
      )}
      {walksList && (
        <span
          className="shrink-0 rounded border border-primary/40 bg-primary/10 px-1 font-mono text-[9px] font-semibold text-primary"
          title={`Runs once per item in ${listName(data.config?.forEach)}, which an earlier step collected`}
        >
          {walksList}
        </span>
      )}
      {until && (
        <span
          className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1 font-mono text-[9px] font-semibold text-amber-600 dark:text-amber-400"
          title={`Asks again every ${humanDuration(pollTime.intervalMs)} for up to ${humanDuration(pollTime.timeoutMs)}, until ${until}`}
        >
          {/* Amber rather than the primary the other badges use: this one is about time,
              and it is the reason a run that used to take seconds now takes minutes. */}
          polls
        </span>
      )}
      {check && (
        <span
          className="shrink-0 rounded border border-primary/40 bg-primary/10 px-1 font-mono text-[9px] font-semibold text-primary"
          title={`This node expects: ${check}`}
        >
          {/^\d+$/.test(check) ? check : "chk"}
        </span>
      )}

      {/* The verdict, as a glyph rather than only a ring colour — so it survives a
          screenshot, a colour-blind reader, and the validation ring sitting on the
          same node.

          Overlaid on the corner, deliberately *outside* the flex row. In the row it
          widened the node, and only the nodes below max-width: those at their limit
          didn't move, so a column the author had centred came out staggered the
          moment it ran. Nothing about a run may change a node's size. */}
      {(running || lastRun) && (
        <span
          className={`absolute -right-2 -top-2 flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-card text-[10px] font-bold leading-none shadow-sm ${
            // The ring is the card colour, not a border colour: it separates the pip
            // from the node's own ring underneath rather than adding a third outline.
            running ? "bg-primary text-primary-foreground" : statusTone(lastRun!.status)
          }`}
          title={running ? "Running" : `Last run: ${lastRun!.status} in ${lastRun!.duration_ms}ms`}
          aria-label={running ? "running" : `last run ${lastRun!.status}`}
        >
          {running ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : statusIcon(lastRun!.status)}
        </span>
      )}

      {/* The name wraps rather than being cut off once the node reaches its width
          limit, so the node grows downwards instead of hiding what it runs. `break-words`
          keeps whole words together and only splits something with no spaces to break
          at — an endpoint pasted in as a name, say. */}
      <span className="min-w-0 flex-1">
        <span className="block break-words font-mono text-xs font-medium leading-snug text-foreground">
          {displayLabel}
        </span>
        {/* Only when renamed — otherwise this would repeat the title. */}
        {alias && (
          <span className="block break-words font-mono text-[10px] leading-tight text-muted-foreground">
            {testCaseName}
          </span>
        )}
      </span>

      {/* Output handles - bottom and right only */}
      <Handle id="source-bottom" type="source" position={Position.Bottom} className="!bg-primary" />
      <Handle id="source-right" type="source" position={Position.Right} className="!bg-primary" />
    </div>
  );
});

TestCaseNode.displayName = "TestCaseNode";
