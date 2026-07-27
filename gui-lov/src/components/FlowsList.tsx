import { useState } from "react";
import { FolderTree, Plus, Edit2, Trash2, MoreVertical, Copy } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTestProject } from "@/contexts/TestProjectContext";

interface FlowsListProps {
  onOpenFlow: (flowId: string) => void;
  onAddGroup: () => void;
  onEditGroup: (group: any) => void;
  onCloneGroup: (groupId: string) => void;
  onDeleteGroup: (groupId: string) => void;
}

export const FlowsList = ({ onOpenFlow, onAddGroup, onEditGroup, onCloneGroup, onDeleteGroup }: FlowsListProps) => {
  const { testGroups } = useTestProject();
  // Single click selects (highlights); double click opens — mirrors the tests rail.
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

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
                  onClick={() => setSelectedFlowId(group.id)}
                  onDoubleClick={() => { setSelectedFlowId(group.id); onOpenFlow(group.id); }}
                  className={`group flex items-center gap-2 h-[var(--rail-row-h)] px-2 rounded-md border cursor-pointer ${
                    selectedFlowId === group.id ? 'bg-primary/10 border-primary/40' : 'border-transparent hover:bg-sidebar-accent'
                  }`}
                >
                  <FolderTree className="w-4 h-4 flex-shrink-0 text-node-group" />
                  <span
                    className="flex-1 truncate text-[13px] font-normal"
                    style={{ color: selectedFlowId === group.id ? undefined : 'hsl(var(--rail-name-color))' }}
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
                      <DropdownMenuItem onClick={() => onCloneGroup(group.id)}>
                        <Copy className="w-3 h-3 mr-2" />
                        Duplicate Flow
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() => setPendingDelete({ id: group.id, name: group.name })}
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

      {pendingDelete && (
        <ConfirmDialog
          open
          onOpenChange={(o) => { if (!o) setPendingDelete(null); }}
          title="Delete flow?"
          description={`"${pendingDelete.name}" will be deleted. This can't be undone.`}
          onConfirm={() => { onDeleteGroup(pendingDelete.id); setPendingDelete(null); }}
        />
      )}
    </div>
  );
};
