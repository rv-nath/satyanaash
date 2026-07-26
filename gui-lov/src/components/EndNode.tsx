import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { CheckCircle } from "lucide-react";

interface EndNodeData {
  label: string;
}

interface EndNodeProps {
  data: EndNodeData;
}

export const EndNode = memo(({ data }: EndNodeProps) => {
  return (
    <div className="px-3 py-1.5 rounded-full border-2 border-primary bg-primary/10 shadow-md hover:shadow-lg transition-shadow">
      {/* Input handles only - top and left */}
      <Handle id="target-top" type="target" position={Position.Top} className="!bg-primary" />
      <Handle id="target-left" type="target" position={Position.Left} className="!bg-primary" />
      
      <div className="flex items-center gap-1.5">
        <CheckCircle className="w-3.5 h-3.5 text-primary" />
        <span className="text-xs font-semibold text-primary">{data.label}</span>
      </div>
    </div>
  );
});

EndNode.displayName = "EndNode";
