import { useEffect, useState } from "react";
import { Node } from "@xyflow/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ExternalLink, FolderTree } from "lucide-react";
import { useTestProject } from "@/contexts/TestProjectContext";
import type { NodeConfig } from "@/lib/nodeConfig";

/**
 * The panel for a step that runs another flow.
 *
 * Its own component rather than a branch inside `NodeConfigPanel`, for the same reason the
 * await panel is: a sub-flow node has no request, so nothing about endpoints, data rows,
 * polling, assertions or output variables applies. What it *does* have is a flow, and the
 * choice of when it runs.
 *
 * The steps themselves are edited in the flow it points at — opened as an ordinary tab, so its
 * edits save the way every other flow's do. There is deliberately no editor here.
 */
interface SubFlowConfigPanelProps {
  node: Node;
  onClose: () => void;
}

export const SubFlowConfigPanel = ({ node, onClose }: SubFlowConfigPanelProps) => {
  const { flows, updateNodeConfig, openFlowTab } = useTestProject();
  const [alias, setAlias] = useState("");
  const [teardown, setTeardown] = useState(false);

  useEffect(() => {
    const config = (node?.data?.config as NodeConfig) || {};
    setAlias((node?.data?.alias as string) || "");
    setTeardown(config.teardown === true);
  }, [node]);

  const flowId = node?.data?.flowId as string | undefined;
  const target = flows.find((f) => f.id === flowId);
  const steps = target?.internalNodes?.filter(
    (n) => n.type === "testCase" || n.type === "awaitCallback" || n.type === "group",
  ).length;

  const handleSave = () => {
    // Only the two keys this node has. Writing the request panel's whole config here would
    // put `outputVars` and `check` on a node that can never produce either.
    updateNodeConfig(node.id, { teardown }, alias);
    onClose();
  };

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="flex w-[560px] max-w-[94vw] flex-col gap-0 p-0 sm:max-w-[94vw]"
      >
        <header className="shrink-0 border-b border-border px-6 py-4 pr-12">
          <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
            <FolderTree className="h-4 w-4 text-node-group" />
            Sub-flow
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            This step runs another flow. Its steps become part of this run, and whatever it
            exports is available to the steps after it.
          </p>
        </header>

        <div className="scrollbar-hairline min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <Field label="Step name" htmlFor="sub-name" help="Shown on the canvas and in results.">
            <Input
              id="sub-name"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder={target?.name || "Name this step"}
              className="h-9 text-[13px]"
            />
          </Field>

          <Field
            label="Runs this flow"
            help={
              target
                ? `${steps} step${steps === 1 ? "" : "s"}. Editing it changes every flow that uses it.`
                : "This flow no longer exists. The run will refuse to start until this step is repointed or removed."
            }
          >
            <div className="flex items-center gap-2">
              <div
                className={`flex h-9 min-w-0 flex-1 items-center rounded-md border px-3 text-[13px] ${
                  target ? "border-input bg-muted/40 text-foreground" : "border-destructive/50 text-destructive"
                }`}
              >
                <span className="truncate">{target?.name ?? flowId ?? "No flow set"}</span>
              </div>
              <Button
                variant="outline"
                className="h-9 shrink-0"
                disabled={!target}
                onClick={() => flowId && openFlowTab(flowId, true)}
              >
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                Open
              </Button>
            </div>
          </Field>

          <Field
            label="When"
            help={
              teardown
                ? "Every step of the sub-flow runs at the end, after this flow — for cleanup."
                : "In order, where you placed it on the canvas. A cleanup step inside the sub-flow still runs at the end of this run, not at the end of the sub-flow."
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
              <ToggleGroupItem
                value="flow"
                className="h-9 px-3 text-[13px] data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
              >
                In the flow
              </ToggleGroupItem>
              <ToggleGroupItem
                value="end"
                className="h-9 px-3 text-[13px] data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
              >
                At the end · cleanup
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
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

/** A labelled field with one short line under it, matching the request panel's own. */
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
      <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">{help}</p>
    </div>
  );
}
