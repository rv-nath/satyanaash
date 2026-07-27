import { useState, useEffect } from "react";
import { Node } from "@xyflow/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Trash2, Plus, X, ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { useTestProject } from "@/contexts/TestProjectContext";

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

export const NodeConfigPanel = ({ node, onClose }: NodeConfigPanelProps) => {
  const { updateNodeConfig } = useTestProject();
  const [inputVars, setInputVars] = useState<InputVariable[]>([]);
  const [outputVars, setOutputVars] = useState<OutputVariable[]>([]);
  const [alias, setAlias] = useState("");

  useEffect(() => {
    setAlias((node?.data?.alias as string) || "");
    if (node?.data?.config) {
      const config = node.data.config as { inputVars?: InputVariable[]; outputVars?: OutputVariable[] };
      setInputVars(config.inputVars || []);
      setOutputVars(config.outputVars || []);
    } else {
      setInputVars([]);
      setOutputVars([]);
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
    updateNodeConfig(node.id, { inputVars, outputVars }, alias);
    onClose();
  };

  if (!node || node.type === "start" || node.type === "end") {
    return null;
  }

  // The request behind this node — the name field's placeholder and the subtitle.
  const testCaseName = (node.data.label as string) || "";

  return (
    <div className="absolute right-4 top-4 bottom-4 z-50 flex w-[680px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">Configure node</h2>
          <p className="mt-0.5 truncate text-[13px] text-muted-foreground">
            {testCaseName || node.id}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onClose}
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Scrollable body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <p className="mb-6 text-xs leading-relaxed text-muted-foreground">
          Set <span className="text-foreground">input</span> values for this node — they
          override anything an earlier step left behind — and extract{" "}
          <span className="text-foreground">output</span> values from its response for
          downstream nodes. Reference any of them elsewhere as{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{"{{name}}"}</code>.
        </p>

        <div className="mb-6">
          <label
            htmlFor="node-name"
            className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Node name
          </label>
          <Input
            id="node-name"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder={testCaseName || "Name this step"}
            className="mt-1.5 h-9 text-[13px]"
          />
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            What this step is for, shown on the canvas and in results — e.g.{" "}
            <span className="text-foreground">Login as new user</span> and{" "}
            <span className="text-foreground">Root login</span> for two nodes running
            the same request. Leave it blank to use the request's own name.
          </p>
        </div>

        {/* Input Variables */}
        <Section
          icon={<ArrowDownToLine className="h-3.5 w-3.5" />}
          title="Input variables"
          subtitle="Set here, these win over earlier steps — for this node only"
          onAdd={addInputVar}
          accent={false}
        >
          {inputVars.length === 0 ? (
            <EmptyRow label="No input variables" />
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

        <div className="my-6 h-px bg-border" />

        {/* Output Variables */}
        <Section
          icon={<ArrowUpFromLine className="h-3.5 w-3.5" />}
          title="Output variables"
          subtitle="Extracted from the response via JSONPath"
          onAdd={addOutputVar}
          accent
        >
          {outputVars.length === 0 ? (
            <EmptyRow label="No output variables" />
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
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            Paths are JSONPath rooted at the response body — e.g.{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">$.data.token</code>.
          </p>
        </Section>
      </div>

      {/* Footer */}
      <div className="flex shrink-0 justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
        <Button variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave}>
          Save configuration
        </Button>
      </div>
    </div>
  );
};

/* ---------- small building blocks ---------- */

function Section({
  icon,
  title,
  subtitle,
  onAdd,
  accent,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onAdd: () => void;
  accent: boolean;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span
            className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
              accent ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
            }`}
          >
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
    <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
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
