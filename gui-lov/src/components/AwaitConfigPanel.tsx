import { useEffect, useState } from "react";
import { Node } from "@xyflow/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SuggestInput } from "@/components/SuggestInput";
import { Check, Hourglass, Info, Plus, Trash2 } from "lucide-react";
import { useTestProject } from "@/contexts/TestProjectContext";
import { getUpstreamCollections } from "@/lib/variableUtils";
import {
  AWAIT_TIMEOUT_MS,
  awaitListCheck,
  awaitSummary,
  listName,
  stripBraces,
  type NodeConfig,
  type OutputVariable,
} from "@/lib/nodeConfig";

/**
 * The panel for a step that waits for a callback.
 *
 * Its own component rather than a branch inside `NodeConfigPanel`, because almost nothing there
 * applies: an await node has no request, so it has no dataset rows to pick, no polling, and no
 * endpoint to show in the header.
 *
 * **Every field says one short thing, with the long version behind an ⓘ.** The first version put
 * the whole explanation under each field in 11px grey — three paragraphs of small print above the
 * box you came to fill in, which reads as a wall and gets skipped, and a skipped explanation is
 * the same as an unwritten one. The short line answers "what do I type here"; the popover answers
 * "why", for the fields where an author actually wants to know.
 */
interface AwaitConfigPanelProps {
  node: Node;
  onClose: () => void;
}

/** Seconds in the boxes, milliseconds on the wire — the same split the poll fields use. */
const toSeconds = (ms: number) => String(Math.round(ms / 100) / 10);

export const AwaitConfigPanel = ({ node, onClose }: AwaitConfigPanelProps) => {
  const { updateNodeConfig, nodes, edges } = useTestProject();
  const [alias, setAlias] = useState("");
  const [path, setPath] = useState("");
  const [count, setCount] = useState("1");
  const [timeoutSec, setTimeoutSec] = useState(toSeconds(AWAIT_TIMEOUT_MS));
  /** Once, or once per item in a list. A wait has no body to vary, so there is no "per row". */
  const [perItem, setPerItem] = useState(false);
  const [forEachList, setForEachList] = useState("");
  const [matchExpr, setMatchExpr] = useState("");
  const [check, setCheck] = useState("");
  const [outputVars, setOutputVars] = useState<OutputVariable[]>([]);

  useEffect(() => {
    const config = (node?.data?.config as NodeConfig) || {};
    const wait = config.awaitCallback || {};
    setAlias((node?.data?.alias as string) || "");
    setPath(wait.path || "");
    // A 0 on the wire means "cleared", so it shows as the default it will behave as rather
    // than as a 0 the author never typed.
    setCount(String(wait.count && wait.count > 0 ? wait.count : 1));
    setTimeoutSec(toSeconds(wait.timeoutMs && wait.timeoutMs > 0 ? wait.timeoutMs : AWAIT_TIMEOUT_MS));
    // The *presence* of the block is the mode, not whether it names a list — so a node saved with
    // the toggle on and the list empty opens showing that, rather than quietly reading as "once".
    setPerItem(!!config.forEach);
    setForEachList(listName(config.forEach));
    setMatchExpr(wait.match || "");
    setCheck(config.check || "");
    setOutputVars(config.outputVars || []);
  }, [node]);

  // What earlier steps in this flow collect into. Guarded rather than assumed: the graph arrives
  // with the flow, so a panel opened before it lands — or rendered against a context with no
  // canvas — would otherwise take the whole sheet down inside the traversal.
  const upstreamLists =
    node && nodes?.length && edges?.length ? getUpstreamCollections(node.id, nodes, edges) : [];
  const listCheck = awaitListCheck(forEachList, upstreamLists);
  // Offered only when there is exactly one candidate, where it is the answer rather than a guess
  // between several.
  const listSuggestion = upstreamLists.length === 1 ? upstreamLists[0] : undefined;

  const wantedCount = Math.max(1, Math.round(Number(count) || 1));
  const wantedMs = Math.max(1, Math.round((Number(timeoutSec) || 0) * 1000)) || AWAIT_TIMEOUT_MS;

  const handleSave = () => {
    updateNodeConfig(
      node.id,
      {
        awaitCallback: {
          path: path.trim(),
          count: wantedCount,
          timeoutMs: wantedMs,
          // Omitted when blank, like every other optional key here: a dormant condition reads as
          // one in force.
          ...(matchExpr.trim() ? { match: matchExpr.trim() } : {}),
        },
        check,
        outputVars,
        // Written whenever the toggle is on, **even with no list named**. Writing it only once a
        // list had been filled in meant the panel said "per item" and the saved config said
        // "once": the step then waited for a single callback while the author believed it waited
        // for one per message, and nothing warned because nothing could see the disagreement. Now
        // the config says what the toggle says, and the validator reports the missing list before
        // the run rather than after a puzzling one.
        ...(perItem ? { forEach: { list: stripBraces(forEachList) } } : {}),
      },
      alias,
    );
    onClose();
  };

  const updateVar = (index: number, field: keyof OutputVariable, value: string) =>
    setOutputVars((v) => v.map((row, i) => (i === index ? { ...row, [field]: value } : row)));

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="flex w-[620px] max-w-[94vw] flex-col gap-0 p-0 sm:max-w-[94vw]"
      >
        <header className="shrink-0 border-b border-border px-6 py-4 pr-12">
          <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Hourglass className="h-4 w-4 text-warning" />
            Await callback
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            This step sends nothing. It waits for something to arrive.
          </p>
        </header>

        <div className="scrollbar-hairline min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <Field label="Step name" htmlFor="await-name" hint="Shown on the canvas and in results.">
            <Input
              id="await-name"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="Await callback"
              className="h-9 text-[13px]"
            />
          </Field>

          <Field
            label="Runs"
            htmlFor="await-runs"
            hint={
              perItem
                ? "One wait per item, each with its own verdict."
                : "One wait. Right when a single message is in flight."
            }
            more={
              <>
                <p>
                  <strong>Once</strong> waits for one callback — or as many as “Callbacks to wait
                  for” says — and gives the step a single verdict.
                </p>
                <p>
                  <strong>Once per item in a list</strong> is how you make this step run several
                  times. It walks a list an earlier step collected, one wait per element, so a
                  report that never came is named by the <em>message</em> that asked for it instead
                  of the step failing with a count. Each item gets its own verdict and its own line
                  in the console.
                </p>
                <p>
                  Per item you almost always want “Which callback is mine” filled in as well, or
                  every wait takes whichever callback happens to arrive first.
                </p>
              </>
            }
          >
            <div className="space-y-2">
              <ToggleGroup
                id="await-runs"
                type="single"
                value={perItem ? "items" : "once"}
                onValueChange={(v) => v && setPerItem(v === "items")}
                className="justify-start"
              >
                <ToggleGroupItem value="once" className="h-8 px-3 text-[12px]">
                  Once
                </ToggleGroupItem>
                <ToggleGroupItem value="items" className="h-8 px-3 text-[12px]">
                  Once per item in a list
                </ToggleGroupItem>
              </ToggleGroup>
              {perItem && (
                <>
                  <SuggestInput
                    aria-label="List to walk"
                    suggestion={listSuggestion}
                    placeholder="sent"
                    value={forEachList}
                    onChange={(e) => setForEachList(e.target.value)}
                    onAccept={setForEachList}
                    className="h-9 font-mono text-[13px]"
                  />
                  {/* Checked against the graph as it is typed, in three states. Absence is a doubt
                      rather than an error — a project variable or a script can hold a list too, and
                      calling a right name wrong teaches an author to ignore the panel. */}
                  <p
                    className={`flex items-start gap-1 text-[11px] leading-relaxed ${
                      listCheck.state === "missing"
                        ? "text-destructive"
                        : listCheck.state === "collected"
                          ? "text-success"
                          : "text-warning"
                    }`}
                  >
                    {listCheck.state === "collected" && (
                      <Check className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                    )}
                    {listCheck.text}
                  </p>
                </>
              )}
            </div>
          </Field>

          <Field
            label="Which inbox to watch"
            htmlFor="await-path"
            hint="The part of your callback URL after /hooks/."
            more={
              <>
                <p>
                  Your test tells the sender where to call back. Satyanaash listens on{" "}
                  <code>http://&lt;this machine&gt;:3002/hooks/…</code> and everything after{" "}
                  <code>/hooks/</code> is a name you invent — one inbox per name, created the moment
                  something arrives for it.
                </p>
                <p>
                  <strong>The same path is written twice</strong> — once in the callback URL you
                  send, and once here — so hold it in one variable and use that variable in both
                  places. Change it once and both follow; hardcode it twice and one day they will
                  not match, and this step waits on an inbox nothing is writing to.
                </p>
                <div className="rounded border border-border bg-muted/40 p-2 font-mono text-[11px]">
                  <div className="text-muted-foreground/70">a pre-test script, or a dataset column</div>
                  <div>{'SAT.vars.dr_path = "dr/" + uuid();'}</div>
                  <div className="mt-1.5 text-muted-foreground/70">in the payload you send</div>
                  <div>{'"drCallback": "{{hook_base}}/{{dr_path}}"'}</div>
                  <div className="mt-1.5 text-muted-foreground/70">in this field</div>
                  <div>{"{{dr_path}}"}</div>
                </div>
                <p>
                  Whether the <code>dr/</code> lives inside the variable or is typed in both places
                  is up to you — what matters is that the part that <em>varies</em> is written once.
                </p>
                <p>
                  <code>hook_base</code> is your own project variable holding the address that
                  reaches this machine <em>from the sender</em> — for a pod in minikube that is the
                  cluster gateway, not <code>localhost</code>.
                </p>
              </>
            }
          >
            {/* The prefix is shown rather than described. A bare box labelled "path" gave no clue
                what it was the tail of, which was the whole complaint. */}
            <div className="flex items-center rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
              <span className="shrink-0 border-r border-input px-2.5 py-2 font-mono text-[12px] text-muted-foreground">
                /hooks/
              </span>
              <Input
                id="await-path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="dr/{{dr_path}}"
                className="h-9 border-0 font-mono text-[13px] shadow-none focus-visible:ring-0"
              />
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Callbacks to wait for"
              htmlFor="await-count"
              hint={perItem ? "Per item. Usually 1." : "Usually 1."}
              more={
                <>
                  <p>
                    How many callbacks must arrive before this wait is satisfied. One message
                    normally produces one delivery report, so 1 is almost always right.
                  </p>
                  <p>
                    Raise it when a <em>single</em> request produces several reports — a campaign to
                    two recipients reporting twice, say.
                  </p>
                  <p>
                    <strong>It is not the number of messages you sent.</strong> For one wait per
                    message, use “Once per item in a list” above and leave this at 1.
                  </p>
                </>
              }
            >
              <Input
                id="await-count"
                type="number"
                min={1}
                value={count}
                onChange={(e) => setCount(e.target.value)}
                className="h-9 text-[13px]"
              />
            </Field>
            <Field
              label="Give up after"
              htmlFor="await-timeout"
              hint="Seconds. Then the step fails."
              more={
                <>
                  <p>
                    Timing out is a <strong>failure, not an error</strong> — nothing broke, the
                    callback did not come — so the flow takes its failure edge and the rest of the
                    run still happens.
                  </p>
                  <p>
                    The budget is <em>per wait</em>. Running per item, three missing reports cost
                    three timeouts, so keep this low while the sender does not post callbacks yet.
                  </p>
                </>
              }
            >
              <Input
                id="await-timeout"
                type="number"
                min={1}
                value={timeoutSec}
                onChange={(e) => setTimeoutSec(e.target.value)}
                className="h-9 text-[13px]"
              />
            </Field>
          </div>

          <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            {awaitSummary({
              path,
              count: wantedCount,
              timeoutMs: wantedMs,
              ...(matchExpr.trim() ? { match: matchExpr.trim() } : {}),
            })}
          </p>

          <Field
            label="Which callback is mine"
            htmlFor="await-match"
            hint="Optional. Needed once several messages are in flight."
            more={
              <>
                <p>
                  Every report for one inbox lands in the same place, and they arrive in whatever
                  order the network gives them — so with several messages in flight, “the next
                  callback” is not “mine”.
                </p>
                <p>
                  Put a correlation id in the callback URL’s query —{" "}
                  <code>?cTxnId={"{{cTxnId}}"}</code> — and match on it here. The URL was yours to
                  hand out, so the query comes back exactly as you sent it; this needs nothing from
                  the sender’s payload.
                </p>
                <p>
                  If a sender rebuilds the URL and drops the query, match on the body instead:{" "}
                  <code>{'response.json.clientTxnId == "{{cTxnId}}"'}</code>.
                </p>
              </>
            }
          >
            <Input
              id="await-match"
              value={matchExpr}
              onChange={(e) => setMatchExpr(e.target.value)}
              placeholder='response.query.cTxnId == "{{cTxnId}}"'
              className="h-9 font-mono text-[13px]"
            />
          </Field>

          <Field
            label="Expect"
            htmlFor="await-check"
            hint="Optional. Blank means arrival alone is the assertion."
            more={
              <>
                <p>
                  An expression about what arrived, e.g.{" "}
                  <code>{'response.json.status == "DELIVERED"'}</code>. Leave it blank and the step
                  passes as soon as a callback turns up, whatever it says.
                </p>
                <p>
                  <strong>Not a status code.</strong> A callback is a request, so it carries no
                  status of its own — the 200 on the report is what satyanaash replied to the
                  sender. A status code here is refused rather than passing on that 200.
                </p>
              </>
            }
          >
            <Input
              id="await-check"
              value={check}
              onChange={(e) => setCheck(e.target.value)}
              placeholder='response.json.status == "DELIVERED"'
              className="h-9 font-mono text-[13px]"
            />
          </Field>

          <section>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Output variables</h3>
                <p className="text-xs text-muted-foreground">
                  Take a field out of the callback for a later step.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0 gap-1.5"
                onClick={() => setOutputVars((v) => [...v, { name: "", path: "" }])}
              >
                <Plus className="h-3.5 w-3.5" />
                Add
              </Button>
            </div>

            {outputVars.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
                Nothing is taken from the callback.
              </div>
            ) : (
              <div className="space-y-2">
                {outputVars.map((row, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={row.name}
                      onChange={(e) => updateVar(i, "name", e.target.value)}
                      placeholder="delivered_id"
                      aria-label={`Output variable ${i + 1} name`}
                      className="h-9 text-[13px]"
                    />
                    <Input
                      value={row.path}
                      onChange={(e) => updateVar(i, "path", e.target.value)}
                      placeholder="$.messageId"
                      aria-label={`Output variable ${i + 1} path`}
                      className="h-9 font-mono text-[13px]"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove output variable ${i + 1}`}
                      onClick={() => setOutputVars((v) => v.filter((_, j) => j !== i))}
                      className="h-9 w-9 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <footer className="flex shrink-0 justify-end gap-2 border-t border-border px-6 py-4">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </footer>
      </SheetContent>
    </Sheet>
  );
};

/**
 * A labelled field: one short hint, and the long explanation behind an ⓘ.
 *
 * The ⓘ appears only where there is more to say, so its presence means "there is depth here"
 * rather than being furniture on every row.
 */
function Field({
  label,
  htmlFor,
  hint,
  more,
  children,
}: {
  label: string;
  htmlFor: string;
  hint: string;
  more?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <label
          htmlFor={htmlFor}
          className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          {label}
        </label>
        {more && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={`About ${label}`}
                className="rounded text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Info className="h-3.5 w-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-[420px] space-y-2.5 text-[12px] leading-relaxed text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[11px] [&_strong]:text-foreground"
            >
              <p className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
                {label}
              </p>
              {more}
            </PopoverContent>
          </Popover>
        )}
      </div>
      <div className="mt-1.5">{children}</div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
    </div>
  );
}
