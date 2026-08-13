import { useEffect, useState } from "react";
import { Node } from "@xyflow/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Hourglass, Plus, Trash2 } from "lucide-react";
import { useTestProject } from "@/contexts/TestProjectContext";
import {
  AWAIT_TIMEOUT_MS,
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
 * applies: an await node has no request, so it has no dataset rows to pick, no polling, no run
 * mode, and no endpoint to show in the header. What it shares — a name, an Expect, output
 * variables — is a handful of fields, and a second panel is cheaper to read than a big one
 * hiding two thirds of itself.
 */
interface AwaitConfigPanelProps {
  node: Node;
  onClose: () => void;
}

/** Seconds in the boxes, milliseconds on the wire — the same split the poll fields use. */
const toSeconds = (ms: number) => String(Math.round(ms / 100) / 10);

export const AwaitConfigPanel = ({ node, onClose }: AwaitConfigPanelProps) => {
  const { updateNodeConfig } = useTestProject();
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
    setPerItem(!!listName(config.forEach));
    setForEachList(listName(config.forEach));
    setMatchExpr(wait.match || "");
    setCheck(config.check || "");
    setOutputVars(config.outputVars || []);
  }, [node]);

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
        // Written only for the mode it belongs to, so switching back to "once" leaves no dormant
        // block behind — the same rule the request node's `forEach` and `poll` follow.
        ...(perItem && forEachList.trim()
          ? { forEach: { list: stripBraces(forEachList) } }
          : {}),
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
          <Labelled
            label="Name"
            htmlFor="await-name"
            help="Shown on the canvas and in results."
          >
            <Input
              id="await-name"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="Await callback"
              className="h-9 text-[13px]"
            />
          </Labelled>

          <Labelled
            label="Runs"
            htmlFor="await-runs"
            help={
              perItem
                ? "One wait per item, each with its own verdict — so a report that never came is named by the message that asked for it. Give each one a match below, or they all take the first callback that arrives."
                : "One wait for this step. Right when a flow has a single message in flight."
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
                <Input
                  aria-label="List to walk"
                  value={forEachList}
                  onChange={(e) => setForEachList(e.target.value)}
                  placeholder="sent — a list an earlier step collected"
                  className="h-9 font-mono text-[13px]"
                />
              )}
            </div>
          </Labelled>

          <Labelled
            label="Path"
            htmlFor="await-path"
            help={
              "The tail of the URL your test puts in its payload — the part after /hooks/. " +
              "Use one variable in both so they cannot drift: dr/{{dr_path}} here, and " +
              "{{hook_base}}/{{dr_path}} in the payload, with hook_base a project variable " +
              "holding the address that reaches this machine from the sender."
            }
          >
            <Input
              id="await-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="dr/{{dr_path}}"
              className="h-9 font-mono text-[13px]"
            />
          </Labelled>

          <div className="grid grid-cols-2 gap-4">
            <Labelled
              label="How many"
              htmlFor="await-count"
              help="A campaign to two recipients reports twice."
            >
              <Input
                id="await-count"
                type="number"
                min={1}
                value={count}
                onChange={(e) => setCount(e.target.value)}
                className="h-9 text-[13px]"
              />
            </Labelled>
            <Labelled
              label="Give up after"
              htmlFor="await-timeout"
              help="Seconds. Then the step fails."
            >
              <Input
                id="await-timeout"
                type="number"
                min={1}
                value={timeoutSec}
                onChange={(e) => setTimeoutSec(e.target.value)}
                className="h-9 text-[13px]"
              />
            </Labelled>
          </div>

          <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            {awaitSummary({ path, count: wantedCount, timeoutMs: wantedMs })}
          </p>

          <Labelled
            label="Which callback is mine"
            htmlFor="await-match"
            help={
              "Optional. Leave blank when only one message is in flight. With several, put a " +
              "correlation id in the callback URL's query — ?cTxnId={{cTxnId}} — and match on it " +
              "here, so each wait picks out its own report however they arrive."
            }
          >
            <Input
              id="await-match"
              value={matchExpr}
              onChange={(e) => setMatchExpr(e.target.value)}
              placeholder='response.query.cTxnId == "{{cTxnId}}"'
              className="h-9 font-mono text-[13px]"
            />
          </Labelled>

          <Labelled
            label="Expect"
            htmlFor="await-check"
            help={
              "An expression about what arrived, e.g. response.json.status == \"DELIVERED\". " +
              "Leave it blank and arrival alone is the assertion. Not a status code — a callback " +
              "is a request and carries none of its own."
            }
          >
            <Input
              id="await-check"
              value={check}
              onChange={(e) => setCheck(e.target.value)}
              placeholder='response.json.status == "DELIVERED"'
              className="h-9 font-mono text-[13px]"
            />
          </Labelled>

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

function Labelled({
  label,
  htmlFor,
  help,
  children,
}: {
  label: string;
  htmlFor: string;
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
