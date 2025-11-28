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
    <div className="px-6 py-4 rounded-full border-2 border-success bg-success/10 shadow-lg hover:shadow-xl transition-shadow">
      <div className="flex items-center gap-2">
        <PlayCircle className="w-5 h-5 text-success" />
        <span className="text-sm font-semibold text-success">{data.label}</span>
      </div>
      
      {/* Output handles only - bottom and right */}
      <Handle id="source-bottom" type="source" position={Position.Bottom} className="!bg-success" />
      <Handle id="source-right" type="source" position={Position.Right} className="!bg-success" />
    </div>
  );
});

StartNode.displayName = "StartNode";
