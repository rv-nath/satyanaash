import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { PlayCircle } from "lucide-react";

interface StartNodeData {
  label: string;
}

interface StartNodeProps {
  data: StartNodeData;
}

export const StartNode = memo(({ data }: StartNodeProps) => {
  return (
    <div className="px-3 py-1.5 rounded-full border-2 border-success bg-success/10 shadow-md hover:shadow-lg transition-shadow">
      <div className="flex items-center gap-1.5">
        <PlayCircle className="w-3.5 h-3.5 text-success" />
        <span className="text-xs font-semibold text-success">{data.label}</span>
      </div>
      
      {/* Output handles only - bottom and right */}
      <Handle id="source-bottom" type="source" position={Position.Bottom} className="!bg-success" />
      <Handle id="source-right" type="source" position={Position.Right} className="!bg-success" />
    </div>
  );
});

StartNode.displayName = "StartNode";
