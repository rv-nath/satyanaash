import { useState, useEffect } from "react";
import { Node } from "@xyflow/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Trash2, Plus, ArrowDownToLine, ArrowUpFromLine, Rows3 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { isStatusShorthand, oneLine, rowLabel } from "@/lib/dataset";
import {
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  msToSeconds,
  pollSummary,
  pollTiming,
  secondsToMs,
} from "@/lib/poll";
import { useTestProject } from "@/contexts/TestProjectContext";
import { useTestCases } from "@/hooks/useApi";

interface InputVariable {
  key: string;
  value: string;
}

interface OutputVariable {
  name: string;
  path: string; // JSONPath rooted at the response body, e.g. "$.data.token"
  description?: string;
}

interface NodeConfigPanelProps {
  node: Node | null;
  onClose: () => void;
}

/**
 * Per-node configuration.
 *
 * Two tiers, because the contents are two different kinds of thing: what this node
 * *is* (its name, when it runs, what it must return) reads as a short form, and the
 * variable tables are repeatable collections that need room. Giving all five equal
 * weight — an icon medallion and a paragraph each, as this once did — made a small
 * form look like a settings app.
 *
 * A sheet against the right edge, full height. It was once positioned inside the
 * canvas pane, which meant opening the console shortened the pane — and the panel
 * with it — leaving the form to cram into whatever height was left. Anchoring to the
 * viewport removes that coupling entirely.
 */
export const NodeConfigPanel = ({ node, onClose }: NodeConfigPanelProps) => {
  const { updateNodeConfig, projectId } = useTestProject();
  // Resolve the request's *current* name, as the canvas does. node.data.label is a
  // snapshot from when the node was created, so a renamed test case showed its old
  // name here — misleading precisely when you are checking which request a node runs.
  const { data: testCases } = useTestCases(projectId || "");
  const [inputVars, setInputVars] = useState<InputVariable[]>([]);
  const [outputVars, setOutputVars] = useState<OutputVariable[]>([]);
  const [alias, setAlias] = useState("");
  const [check, setCheck] = useState("");
  const [teardown, setTeardown] = useState(false);
  const [forEachRow, setForEachRow] = useState(false);
  /** Multi-stage: the first answer only acknowledges, so this node asks again. Off is the
   *  absence of a `poll` block, which is every node that predates the feature. */
  const [polls, setPolls] = useState(false);
  const [until, setUntil] = useState("");
  // Seconds, because that is how a wait is thought about. Milliseconds on the wire.
  const [intervalSec, setIntervalSec] = useState(msToSeconds(POLL_INTERVAL_MS));
  const [timeoutSec, setTimeoutSec] = useState(msToSeconds(POLL_TIMEOUT_MS));
  /** `null` means every row — the same thing an absent `rowIds` means on the wire, so a
   *  row added to the dataset later is included without anyone revisiting this node. */
  const [rowIds, setRowIds] = useState<string[] | null>(null);

  useEffect(() => {
    setAlias((node?.data?.alias as string) || "");
    if (node?.data?.config) {
      const config = node.data.config as {
        inputVars?: InputVariable[];
        outputVars?: OutputVariable[];
        check?: string;
        teardown?: boolean;
        forEachRow?: boolean;
        rowIds?: string[];
        poll?: { until?: string; intervalMs?: number; timeoutMs?: number };
      };
      setInputVars(config.inputVars || []);
      setOutputVars(config.outputVars || []);
      setCheck(config.check || "");
      setTeardown(config.teardown === true);
      setForEachRow(config.forEachRow === true);
      setRowIds(Array.isArray(config.rowIds) ? config.rowIds : null);
      // An `until` is what makes a node poll, so it is what the toggle reflects — a
      // leftover interval with no condition is not polling, here or in the engine.
      const timing = pollTiming(config.poll);
      setPolls(!!config.poll?.until?.trim());
      setUntil(config.poll?.until || "");
      setIntervalSec(msToSeconds(timing.intervalMs));
      setTimeoutSec(msToSeconds(timing.timeoutMs));
    } else {
      setInputVars([]);
      setOutputVars([]);
      setCheck("");
      setTeardown(false);
      setForEachRow(false);
      setRowIds(null);
      setPolls(false);
      setUntil("");
      setIntervalSec(msToSeconds(POLL_INTERVAL_MS));
      setTimeoutSec(msToSeconds(POLL_TIMEOUT_MS));
    }
  }, [node]);

  const addInputVar = () => setInputVars((v) => [...v, { key: "", value: "" }]);
  const removeInputVar = (index: number) => setInputVars((v) => v.filter((_, i) => i !== index));
  const updateInputVar = (index: number, field: keyof InputVariable, value: string) =>
    setInputVars((v) => v.map((row, i) => (i === index ? { ...row, [field]: value } : row)));

  const addOutputVar = () => setOutputVars((v) => [...v, { name: "", path: "", description: "" }]);
  const removeOutputVar = (index: number) => setOutputVars((v) => v.filter((_, i) => i !== index));
  const updateOutputVar = (index: number, field: keyof OutputVariable, value: string) =>
    setOutputVars((v) => v.map((row, i) => (i === index ? { ...row, [field]: value } : row)));

  const handleSave = () => {
    if (!node) return;
    const config: Record<string, unknown> = { inputVars, outputVars, check, teardown };
    if (forEachRow) {
      config.forEachRow = true;
      // Omitted, not `[]`: absence means every row, an empty list means none.
      if (rowIds !== null) config.rowIds = rowIds;
    }
    // Omitted when off, for the same reason `rowIds` is: absence is how this config says
    // "unset", and a node carrying a dormant `poll` block would read as one that polls.
    if (polls) {
      config.poll = {
        until,
        intervalMs: secondsToMs(intervalSec, POLL_INTERVAL_MS),
        timeoutMs: secondsToMs(timeoutSec, POLL_TIMEOUT_MS),
      };
    }
    updateNodeConfig(node.id, config, alias);
    onClose();
  };

  if (!node || node.type === "start" || node.type === "end") {
    return null;
  }

  const testCase = node.data.testCaseId
    ? testCases?.find((tc) => tc.id === node.data.testCaseId)
    : undefined;
  const testCaseName = testCase?.name || (node.data.label as string) || "";
  const method = testCase?.method || (node.data.method as string) || "";
  const endpoint = testCase?.endpoint || (node.data.endpoint as string) || "";

  // The rows this node could run. Undefined while the request is still loading —
  // computing staleness against that would wipe a perfectly good selection.
  const rows = testCase?.dataset?.rows;
  const loadingRows = testCase === undefined;
  const stale = rows ? (rowIds ?? []).filter((id) => !rows.some((r) => r.id === id)) : [];
  const isSelected = (id: string) => rowIds === null || rowIds.includes(id);
  // Counts describe what will actually be sent, so a parked row is not counted even when
  // it is selected — promising 15 requests and sending 13 is the kind of quiet lie this
  // panel exists to avoid.
  const willRun = (rows ?? []).filter((r) => !r.disabled && isSelected(r.id));
  const selectedCount = willRun.length;
  const runnableTotal = (rows ?? []).filter((r) => !r.disabled).length;
  const parkedCount = (rows?.length ?? 0) - runnableTotal;
  // Milliseconds as they will be sent, so the summary describes the saved node and not
  // whatever the boxes happen to read.
  const pollMs = {
    intervalMs: secondsToMs(intervalSec, POLL_INTERVAL_MS),
    timeoutMs: secondsToMs(timeoutSec, POLL_TIMEOUT_MS),
  };
  const pollLine = pollSummary(pollMs.intervalMs, pollMs.timeoutMs);
  const pollAttemptsWarn = pollMs.timeoutMs < pollMs.intervalMs;

  const toggleRow = (id: string) => {
    setRowIds((current) => {
      // Unticking while "every row" is in force materialises the list minus that row.
      const list = current ?? (rows ?? []).map((r) => r.id);
      return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    });
  };

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="flex w-[720px] max-w-[94vw] flex-col gap-0 p-0 sm:max-w-[94vw]"
      >
        <header className="shrink-0 border-b border-border px-6 py-4 pr-12">
          <h2 className="text-base font-semibold text-foreground">Configure node</h2>
          <p className="mt-0.5 flex items-baseline gap-2 text-[13px] text-muted-foreground">
            <span className="truncate">{testCaseName || node.id}</span>
            {method && (
              <span className="shrink-0 font-mono text-[11px] uppercase text-muted-foreground/70">
                {method}
              </span>
            )}
            {endpoint && (
              <span className="truncate font-mono text-[11px] text-muted-foreground/70">
                {endpoint}
              </span>
            )}
          </p>
        </header>

        <div className="scrollbar-hairline min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {/* Tier one: what this node is. Label, control, one line. */}
          <div className="space-y-5">
            <Field
              label="Name"
              htmlFor="node-name"
              help="Shown on the canvas and in results. Blank uses the request's own name."
            >
              <Input
                id="node-name"
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                placeholder={testCaseName || "Name this step"}
                className="h-9 text-[13px]"
              />
            </Field>

            <Field
              label="Runs"
              help={
                teardown
                  ? "After the flow, whatever happened — for cleanup. Skipped, with a reason, if the values it needs didn't come from this run."
                  : "In order, where you placed it on the canvas."
              }
            >
              <ToggleGroup
                type="single"
                value={teardown ? "end" : "flow"}
                onValueChange={(v) => {
                  if (v) setTeardown(v === "end");
                }}
                className="justify-start gap-1"
              >
                <ToggleGroupItem value="flow" className="h-9 px-3 text-[13px] data-[state=on]:bg-primary/10 data-[state=on]:text-primary">
                  In the flow
                </ToggleGroupItem>
                <ToggleGroupItem value="end" className="h-9 px-3 text-[13px] data-[state=on]:bg-primary/10 data-[state=on]:text-primary">
                  At the end · cleanup
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>

            <Field
              label="Data rows"
              help={
                !rows || rows.length === 0
                  ? "This request has no data rows. Add them in the request's Data tab."
                  : !forEachRow
                    ? "The request runs once, with its own payload — its data rows are ignored."
                    : rowIds === null
                      ? `Every row runs here, in order — ${runnableTotal} requests, each inheriting what earlier steps produced.${
                          parkedCount > 0 ? ` ${parkedCount} disabled row(s) are skipped.` : ""
                        }`
                      : `${selectedCount} of ${runnableTotal} rows run here.${
                          parkedCount > 0 ? ` ${parkedCount} disabled row(s) are skipped.` : ""
                        }`
              }
            >
              <ToggleGroup
                type="single"
                value={forEachRow ? "each" : "once"}
                onValueChange={(v) => {
                  if (v) setForEachRow(v === "each");
                }}
                className="justify-start gap-1"
              >
                <ToggleGroupItem
                  value="once"
                  className="h-9 px-3 text-[13px] data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
                >
                  Once, as authored
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="each"
                  disabled={!rows || rows.length === 0}
                  className="h-9 px-3 text-[13px] data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
                >
                  Once per row{runnableTotal > 0 ? ` · ${runnableTotal}` : ""}
                </ToggleGroupItem>
              </ToggleGroup>
              {/* A config that predates the rows being deleted: say so rather than
                  silently flipping the choice under the author. */}
              {forEachRow && rows && rows.length === 0 && (
                <p className="mt-1.5 text-[11px] text-destructive">
                  This request no longer has any data rows — this step will run once, as
                  authored.
                </p>
              )}
            </Field>

            <Field
              label="Expect"
              htmlFor="node-check"
              help={
                !check.trim()
                  ? "Blank uses the request's own assertion. A status code, or a Rhai expression."
                  : isStatusShorthand(check)
                    ? `Shorthand for response.status == ${check.trim()}. The request's post-test script won't run for this node.`
                    : "Rhai expression — must end in something true or false. The request's post-test script won't run for this node."
              }
            >
              <Input
                id="node-check"
                value={check}
                onChange={(e) => setCheck(e.target.value)}
                placeholder="402   — or an expression"
                className="h-9 font-mono text-[13px]"
              />
            </Field>

            <Field
              label="Answer"
              help={
                polls
                  ? "The first response only acknowledges. This step asks again until the condition below is true, then judges that answer."
                  : "The first response is the outcome. True of almost every request."
              }
            >
              <ToggleGroup
                type="single"
                value={polls ? "later" : "now"}
                onValueChange={(v) => {
                  if (v) setPolls(v === "later");
                }}
                className="justify-start gap-1"
              >
                <ToggleGroupItem
                  value="now"
                  className="h-9 px-3 text-[13px] data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
                >
                  Ready at once
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="later"
                  className="h-9 px-3 text-[13px] data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
                >
                  Arrives later · ask again
                </ToggleGroupItem>
              </ToggleGroup>

              {polls && (
                <div className="mt-3 space-y-3 rounded-md border border-border bg-muted/20 p-3">
                  <div>
                    <label
                      htmlFor="node-until"
                      className="text-[11px] font-medium text-muted-foreground"
                    >
                      Settled when
                    </label>
                    <Input
                      id="node-until"
                      value={until}
                      onChange={(e) => setUntil(e.target.value)}
                      placeholder={'response.json.status != "pending"'}
                      className="mt-1 h-9 font-mono text-[13px]"
                    />
                    {/* The division of labour, stated where the second expression is
                        typed. Without it, "until" and Expect become a guessing game —
                        and an author who collapses them into one gets an upload that
                        failed reported as a timeout. */}
                    <p className="mt-1.5 text-[11px] text-muted-foreground">
                      Says the answer has <span className="text-foreground">settled</span>.
                      Expect, above, says whether it was the{" "}
                      <span className="text-foreground">right</span> answer — so an upload
                      that comes back <code className="font-mono">failed</code> is reported
                      as a failure, not as a timeout.
                    </p>
                    {!until.trim() && (
                      <p className="mt-1.5 text-[11px] text-destructive">
                        Without a condition this step sends once and judges the first
                        answer — which for an upload is the 202 that says only "I have
                        your file".
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-end gap-4">
                    <div>
                      <label
                        htmlFor="node-poll-interval"
                        className="text-[11px] font-medium text-muted-foreground"
                      >
                        Ask every
                      </label>
                      <div className="mt-1 flex items-baseline gap-1.5">
                        <Input
                          id="node-poll-interval"
                          value={intervalSec}
                          onChange={(e) => setIntervalSec(e.target.value)}
                          inputMode="decimal"
                          className="h-9 w-20 text-right font-mono text-[13px] tabular-nums"
                        />
                        <span className="text-[11px] text-muted-foreground">seconds</span>
                      </div>
                    </div>
                    <div>
                      <label
                        htmlFor="node-poll-timeout"
                        className="text-[11px] font-medium text-muted-foreground"
                      >
                        Give up after
                      </label>
                      <div className="mt-1 flex items-baseline gap-1.5">
                        <Input
                          id="node-poll-timeout"
                          value={timeoutSec}
                          onChange={(e) => setTimeoutSec(e.target.value)}
                          inputMode="decimal"
                          className="h-9 w-20 text-right font-mono text-[13px] tabular-nums"
                        />
                        <span className="text-[11px] text-muted-foreground">seconds</span>
                      </div>
                    </div>
                  </div>

                  {/* A budget rather than an attempt count is what the author knows — so
                      the count, which is the arithmetic they would otherwise do, is
                      derived here. It also shows a budget too short to wait even once
                      before anything is saved. */}
                  <p
                    className={`text-[11px] ${
                      pollAttemptsWarn ? "text-destructive" : "text-muted-foreground"
                    }`}
                  >
                    {pollLine}
                  </p>
                </div>
              )}
            </Field>
          </div>

          <div className="my-6 h-px bg-border" />

          {/* Tier two: the collections. */}
          <div className="space-y-6">
            <Section
              icon={<ArrowDownToLine className="h-3.5 w-3.5" />}
              title="Input variables"
              subtitle="Used as {{name}} here, and beat anything an earlier step left behind"
              onAdd={addInputVar}
            >
              {inputVars.length === 0 ? (
                <EmptyRow label="None — this node uses whatever the flow provides" />
              ) : (
                <div className="space-y-1.5">
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto] gap-2 px-0.5">
                    <ColLabel>Name</ColLabel>
                    <ColLabel>Value</ColLabel>
                    <span className="w-9" />
                  </div>
                  {inputVars.map((v, i) => (
                    <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto] items-center gap-2">
                      <Input
                        placeholder="variableName"
                        value={v.key}
                        onChange={(e) => updateInputVar(i, "key", e.target.value)}
                        className="h-9 font-mono text-[13px]"
                      />
                      <Input
                        placeholder="value"
                        value={v.value}
                        onChange={(e) => updateInputVar(i, "value", e.target.value)}
                        className="h-9 font-mono text-[13px]"
                      />
                      <DeleteButton onClick={() => removeInputVar(i)} label="Remove input variable" />
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {forEachRow && (rows?.length ?? 0) > 0 && (
              <Section
                icon={<Rows3 className="h-3.5 w-3.5" />}
                title="Data rows"
                subtitle="Which rows run at this step — a scenario may only satisfy some of them"
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0"
                    disabled={rowIds === null}
                    onClick={() => setRowIds(null)}
                  >
                    All rows
                  </Button>
                }
              >
                {loadingRows ? (
                  <EmptyRow label="Loading this request's rows…" />
                ) : (
                  <div className="space-y-1">
                    {rows!.map((row, i) => (
                      <label
                        key={row.id}
                        className={`flex items-center gap-2.5 rounded px-1 py-1 ${
                          // A parked row runs nowhere, so offering it here would be a
                          // promise this step can't keep.
                          row.disabled ? "opacity-50" : "cursor-pointer hover:bg-muted/30"
                        }`}
                        title={
                          row.disabled
                            ? "Disabled in the request's Data tab — it runs nowhere until enabled"
                            : row.id
                              ? undefined
                              : "This row has no id and can't be picked"
                        }
                      >
                        <Checkbox
                          checked={isSelected(row.id) && !row.disabled}
                          disabled={!row.id || row.disabled === true}
                          onCheckedChange={() => toggleRow(row.id)}
                          aria-label={`Run ${rowLabel(i, row)} at this step`}
                        />
                        <span className="w-4 shrink-0 text-right text-[11px] text-muted-foreground">
                          {i + 1}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[13px]">
                          {rowLabel(i, row)}
                        </span>
                        {row.path && (
                          <span className="shrink-0 truncate font-mono text-[11px] text-muted-foreground/80">
                            {row.path}
                          </span>
                        )}
                        <span className="max-w-[160px] shrink-0 truncate font-mono text-[11px] text-muted-foreground/70">
                          {oneLine(row.body ?? "")}
                        </span>
                        {row.check && (
                          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                            {row.check}
                          </span>
                        )}
                        {row.disabled && (
                          <span className="shrink-0 rounded bg-muted px-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                            off
                          </span>
                        )}
                      </label>
                    ))}
                  </div>
                )}

                {!loadingRows && stale.length > 0 && (
                  <p className="mt-2 text-[11px] leading-relaxed text-destructive">
                    {stale.length} selected row{stale.length === 1 ? "" : "s"} no longer
                    exist in this request.{" "}
                    <button
                      type="button"
                      className="underline hover:no-underline"
                      onClick={() =>
                        setRowIds((current) =>
                          (current ?? []).filter((id) => !stale.includes(id)),
                        )
                      }
                    >
                      Remove them
                    </button>
                  </p>
                )}
                {!loadingRows && rowIds !== null && rowIds.length === 0 && (
                  <p className="mt-2 text-[11px] text-destructive">
                    No rows selected — this step will fail without sending anything.
                  </p>
                )}
              </Section>
            )}

            <Section
              icon={<ArrowUpFromLine className="h-3.5 w-3.5" />}
              title="Output variables"
              subtitle="Pulled from the response by JSONPath, for the steps after this one"
              onAdd={addOutputVar}
            >
              {outputVars.length === 0 ? (
                <EmptyRow label="None — nothing is carried forward from this response" />
              ) : (
                <div className="space-y-1.5">
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)_auto] gap-2 px-0.5">
                    <ColLabel>Name</ColLabel>
                    <ColLabel>JSON path</ColLabel>
                    <ColLabel>Description</ColLabel>
                    <span className="w-9" />
                  </div>
                  {outputVars.map((v, i) => (
                    <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)_auto] items-center gap-2">
                      <Input
                        placeholder="variableName"
                        value={v.name}
                        onChange={(e) => updateOutputVar(i, "name", e.target.value)}
                        className="h-9 font-mono text-[13px]"
                      />
                      <Input
                        placeholder="$.data.token"
                        value={v.path}
                        onChange={(e) => updateOutputVar(i, "path", e.target.value)}
                        className="h-9 font-mono text-[13px]"
                      />
                      <Input
                        placeholder="Optional note"
                        value={v.description || ""}
                        onChange={(e) => updateOutputVar(i, "description", e.target.value)}
                        className="h-9 text-[13px]"
                      />
                      <DeleteButton onClick={() => removeOutputVar(i)} label="Remove output variable" />
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </div>
        </div>

        <footer className="flex shrink-0 justify-end gap-2 border-t border-border bg-muted/30 px-6 py-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave}>
            Save configuration
          </Button>
        </footer>
      </SheetContent>
    </Sheet>
  );
};

/* ---------- small building blocks ---------- */

/** A single setting: label, control, and one line of help. No more than one line —
 *  a paragraph per field is what made this panel read as a wall of grey. */
function Field({
  label,
  htmlFor,
  help,
  children,
}: {
  label: string;
  htmlFor?: string;
  help: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
      >
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{help}</p>
    </div>
  );
}

function Section({
  icon,
  title,
  subtitle,
  onAdd,
  action,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  /** Omitted for a section whose rows come from somewhere else. */
  onAdd?: () => void;
  /** Shown in place of Add — for a section that acts on rows it doesn't own. */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            {icon}
          </span>
          <div>
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        {onAdd && (
          <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1.5" onClick={onAdd}>
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        )}
        {action}
      </div>
      {children}
    </section>
  );
}

function ColLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </span>
  );
}

function EmptyRow({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
      {label}
    </div>
  );
}

function DeleteButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      aria-label={label}
      className="h-9 w-9 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
    >
      <Trash2 className="h-4 w-4" />
    </Button>
  );
}
