import { FolderTree, Plus, Edit2, Trash2, MoreVertical } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTestProject } from "@/contexts/TestProjectContext";

interface FlowsListProps {
  onAddGroup: () => void;
  onEditGroup: (group: any) => void;
  onDeleteGroup: (groupId: string) => void;
}

export const FlowsList = ({ onAddGroup, onEditGroup, onDeleteGroup }: FlowsListProps) => {
  const { id: projectId } = useParams();
  const navigate = useNavigate();
  const { testGroups, activeFlowId, sidebarTab } = useTestProject();

  // Navigate to flow - this closes any open editor and switches to canvas
  const handleFlowClick = (flowId: string) => {
    navigate(`/project/${projectId}?flow=${flowId}&tab=${sidebarTab}`);
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 h-8 px-3 border-b border-sidebar-border">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Flows
        </span>
        <span className="text-[10px] text-muted-foreground/60">{testGroups.length}</span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onAddGroup}
          title="New flow"
        >
          <Plus className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* Flows List */}
      <ScrollArea className="flex-1">
        <div className="p-2">
          {testGroups.length === 0 ? (
            <div className="text-center py-12 px-4">
              <FolderTree className="w-12 h-12 text-muted-foreground/50 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground mb-1">No flows yet</p>
              <p className="text-xs text-muted-foreground/70">
                Create your first flow to organize tests
              </p>
            </div>
          ) : (
            testGroups.map((group) => (
                <div
                  key={group.id}
                  onClick={() => handleFlowClick(group.id)}
                  className={`flex items-center gap-2 h-[var(--rail-row-h)] px-2 hover:bg-sidebar-accent rounded-md transition-colors group cursor-pointer ${
                    activeFlowId === group.id ? 'bg-sidebar-accent border-l-2 border-primary' : ''
                  }`}
                >
                  <FolderTree className="w-4 h-4 flex-shrink-0 text-node-group" />
                  <span
                    className="flex-1 truncate text-[13px] font-normal"
                    style={{ color: activeFlowId === group.id ? undefined : 'hsl(var(--rail-name-color))' }}
                  >
                    {group.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {group.testCases.length}
                  </span>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100">
                        <MoreVertical className="w-3 h-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onEditGroup(group)}>
                        <Edit2 className="w-3 h-3 mr-2" />
                        Edit Flow
                      </DropdownMenuItem>
                      <DropdownMenuItem 
                        className="text-destructive"
                        onClick={() => onDeleteGroup(group.id)}
                      >
                        <Trash2 className="w-3 h-3 mr-2" />
                        Delete Flow
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
};
