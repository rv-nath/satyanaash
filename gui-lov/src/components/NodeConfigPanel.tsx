import { useState, useEffect } from "react";
import { Node } from "@xyflow/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Trash2, Plus, ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { isStatusShorthand } from "@/lib/dataset";
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

  useEffect(() => {
    setAlias((node?.data?.alias as string) || "");
    if (node?.data?.config) {
      const config = node.data.config as {
        inputVars?: InputVariable[];
        outputVars?: OutputVariable[];
        check?: string;
        teardown?: boolean;
      };
      setInputVars(config.inputVars || []);
      setOutputVars(config.outputVars || []);
      setCheck(config.check || "");
      setTeardown(config.teardown === true);
    } else {
      setInputVars([]);
      setOutputVars([]);
      setCheck("");
      setTeardown(false);
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
    updateNodeConfig(node.id, { inputVars, outputVars, check, teardown }, alias);
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
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onAdd: () => void;
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
        <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1.5" onClick={onAdd}>
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
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
