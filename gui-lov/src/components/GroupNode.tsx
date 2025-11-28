import { memo, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { FolderTree, ChevronDown, ChevronRight, Edit } from "lucide-react";
import { GroupEditorDialog } from "./GroupEditorDialog";
import { Button } from "@/components/ui/button";

interface GroupNodeData {
  label: string;
  testCaseCount: number;
  groupId: string;
}

interface GroupNodeProps {
  data: GroupNodeData;
}

export const GroupNode = memo(({ data }: GroupNodeProps) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isEditorOpen, setIsEditorOpen] = useState(false);

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsEditorOpen(true);
  };

  return (
    <>
      <div 
        className="px-4 py-3 rounded-lg border-2 border-node-group bg-card shadow-lg min-w-[220px] hover:shadow-xl transition-shadow"
        onDoubleClick={handleDoubleClick}
      >
        <Handle type="target" position={Position.Top} className="w-3 h-3 !bg-node-group" />
        
        <div 
          className="flex items-start gap-2 cursor-pointer"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? (
            <ChevronDown className="w-4 h-4 text-node-group mt-0.5 flex-shrink-0" />
          ) : (
            <ChevronRight className="w-4 h-4 text-node-group mt-0.5 flex-shrink-0" />
          )}
          <FolderTree className="w-4 h-4 text-node-group mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-foreground truncate">
              {data.label}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {data.testCaseCount} test case{data.testCaseCount !== 1 ? 's' : ''}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => {
              e.stopPropagation();
              setIsEditorOpen(true);
            }}
          >
            <Edit className="h-3 w-3" />
          </Button>
        </div>

        {isExpanded && (
          <div className="mt-2 pt-2 border-t border-border">
            <p className="text-xs text-muted-foreground mb-2">
              Reusable flow • Double-click to edit
            </p>
            <Button
              variant="outline"
              size="sm"
              className="w-full text-xs h-7"
              onClick={(e) => {
                e.stopPropagation();
                setIsEditorOpen(true);
              }}
            >
              <Edit className="h-3 w-3 mr-1" />
              Edit Flow
            </Button>
          </div>
        )}

        <Handle type="source" position={Position.Bottom} className="w-3 h-3 !bg-node-group" />
      </div>

      <GroupEditorDialog
        groupId={data.groupId}
        groupName={data.label}
        open={isEditorOpen}
        onOpenChange={setIsEditorOpen}
      />
    </>
  );
});

GroupNode.displayName = "GroupNode";
