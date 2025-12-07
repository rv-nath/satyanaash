import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { FileCode } from "lucide-react";
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

  return (
    <div className="px-4 py-3 rounded-lg border-2 bg-card shadow-lg min-w-[200px] hover:shadow-xl transition-shadow">
      {/* Input handles - top and left only */}
      <Handle id="target-top" type="target" position={Position.Top} className="!bg-primary" />
      <Handle id="target-left" type="target" position={Position.Left} className="!bg-primary" />
      
      <div className="flex items-start gap-2 mb-2">
        <FileCode className="w-4 h-4 text-node-test mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-mono text-foreground font-medium truncate">
            {displayLabel}
          </div>
          {displayEndpoint && (
            <div className="text-[10px] text-muted-foreground font-mono mt-1 truncate">
              {displayEndpoint}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className={`text-[10px] px-2 py-0.5 rounded border font-mono font-medium ${getMethodColor(displayMethod)}`}>
          {displayMethod}
        </span>
      </div>

      {/* Output handles - bottom and right only */}
      <Handle id="source-bottom" type="source" position={Position.Bottom} className="!bg-primary" />
      <Handle id="source-right" type="source" position={Position.Right} className="!bg-primary" />
    </div>
  );
});

TestCaseNode.displayName = "TestCaseNode";
