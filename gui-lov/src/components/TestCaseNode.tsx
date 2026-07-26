import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useTestProject } from "@/contexts/TestProjectContext";
import { useTestCases } from "@/hooks/useApi";

interface TestCaseNodeData {
  label: string;
  method: string;
  endpoint?: string;
  testCaseId?: string;  // Reference to the test case for live name resolution
}

interface TestCaseNodeProps {
  data: TestCaseNodeData;
}

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

export const TestCaseNode = memo(({ data }: TestCaseNodeProps) => {
  const { projectId } = useTestProject();
  const { data: testCases } = useTestCases(projectId || '');

  // Resolve current name from test cases cache, fallback to stored label
  const currentTestCase = data.testCaseId
    ? testCases?.find(tc => tc.id === data.testCaseId)
    : null;
  const displayLabel = currentTestCase?.name || data.label;
  const displayMethod = currentTestCase?.method || data.method;
  const displayEndpoint = currentTestCase?.endpoint || data.endpoint;

  // Only the name sits on the node. Method and endpoint are one click away via the
  // info button — on hover they'd steal attention while you're reading the graph.
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border-2 bg-card shadow-md min-w-[140px] max-w-[260px] hover:shadow-lg transition-shadow">
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
            className="nodrag shrink-0 rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-auto max-w-[380px] p-3">
          <p className="text-[13px] font-medium leading-snug">{displayLabel}</p>
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
        </PopoverContent>
      </Popover>

      <span className="truncate text-xs font-mono font-medium text-foreground">
        {displayLabel}
      </span>

      {/* Output handles - bottom and right only */}
      <Handle id="source-bottom" type="source" position={Position.Bottom} className="!bg-primary" />
      <Handle id="source-right" type="source" position={Position.Right} className="!bg-primary" />
    </div>
  );
});

TestCaseNode.displayName = "TestCaseNode";
