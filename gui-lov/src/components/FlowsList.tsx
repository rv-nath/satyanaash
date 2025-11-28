import { FolderTree, Plus, Edit2, Trash2, MoreVertical, ChevronRight, FileCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTestProject } from "@/contexts/TestProjectContext";

interface FlowsListProps {
  onAddGroup: () => void;
  onEditGroup: (group: any) => void;
  onDeleteGroup: (groupId: string) => void;
  onAddTestCaseToGroup: (groupId: string) => void;
}

export const FlowsList = ({ onAddGroup, onEditGroup, onDeleteGroup, onAddTestCaseToGroup }: FlowsListProps) => {
  const { testGroups, activeFlowId, setActiveFlowId } = useTestProject();

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-sidebar-border bg-sidebar-accent/30">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-base font-bold text-sidebar-foreground flex items-center gap-2">
              🎯 Test Flows
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {testGroups.length} flow{testGroups.length !== 1 ? 's' : ''} defined
            </p>
          </div>
        </div>
        
        <Button 
          variant="default" 
          size="sm"
          className="w-full gap-2"
          onClick={onAddGroup}
        >
          <Plus className="w-3 h-3" />
          New Flow
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
              <div key={group.id} className="mb-2">
                <div 
                  onClick={() => setActiveFlowId(group.id)}
                  className={`flex items-center gap-2 px-3 py-2 hover:bg-sidebar-accent rounded-md transition-colors group cursor-pointer ${
                    activeFlowId === group.id ? 'bg-sidebar-accent border-l-2 border-primary' : ''
                  }`}
                >
                  <FolderTree className="w-4 h-4 text-node-group" />
                  <span className="text-sm font-medium text-sidebar-foreground flex-1">
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
                      <DropdownMenuItem onClick={() => onAddTestCaseToGroup(group.id)}>
                        <Plus className="w-3 h-3 mr-2" />
                        Add Test Case
                      </DropdownMenuItem>
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
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
};
