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
    <div className="px-6 py-4 rounded-full border-2 border-primary bg-primary/10 shadow-lg hover:shadow-xl transition-shadow">
      {/* Input handles only - top and left */}
      <Handle id="target-top" type="target" position={Position.Top} className="!bg-primary" />
      <Handle id="target-left" type="target" position={Position.Left} className="!bg-primary" />
      
      <div className="flex items-center gap-2">
        <CheckCircle className="w-5 h-5 text-primary" />
        <span className="text-sm font-semibold text-primary">{data.label}</span>
      </div>
    </div>
  );
});

EndNode.displayName = "EndNode";
