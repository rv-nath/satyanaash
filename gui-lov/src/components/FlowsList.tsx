import { useEffect, useMemo, useRef, useState } from "react";
import { FolderTree, Plus, Edit2, Trash2, MoreVertical, Copy, Search, X } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTestProject } from "@/contexts/TestProjectContext";
import { filterFlows, matchNote } from "@/lib/flowSearch";

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
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => filterFlows(testGroups, searchQuery), [testGroups, searchQuery]);
  const searching = searchQuery.trim().length > 0;

  // Ctrl+F reaches for the search only when the focus is already in this rail, so it does
  // not steal the shortcut from the tests rail or the browser. Same rule as TestInventory.
  useEffect(() => {
    const onGlobal = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        if (
          listRef.current?.contains(document.activeElement) ||
          searchInputRef.current?.contains(document.activeElement as Node)
        ) {
          e.preventDefault();
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        }
      }
    };
    document.addEventListener("keydown", onGlobal);
    return () => document.removeEventListener("keydown", onGlobal);
  }, []);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="border-b border-sidebar-border">
      <div className="flex items-center gap-2 h-8 px-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Flows
        </span>
        <span className="text-[10px] text-muted-foreground/60">
          {matches.length === testGroups.length
            ? testGroups.length
            : `${matches.length}/${testGroups.length}`}
        </span>
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

        {/* Search */}
        <div className="relative px-2 pb-2">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            type="text"
            placeholder="Search flows and their requests..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                // Clear first, blur only when there is nothing left to clear — Escape on a
                // filtered list should give the list back, not just move the cursor.
                if (searchQuery) setSearchQuery("");
                else searchInputRef.current?.blur();
              }
            }}
            className="pl-8 pr-8 h-7 text-xs"
          />
          {searchQuery && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-3 top-1/2 -translate-y-1/2 h-6 w-6"
              onClick={() => setSearchQuery("")}
              title="Clear search"
            >
              <X className="w-3 h-3" />
            </Button>
          )}
        </div>
      </div>

      {/* Flows List */}
      <ScrollArea className="flex-1">
        <div ref={listRef} className="p-2" tabIndex={0}>
          {testGroups.length === 0 ? (
            <div className="text-center py-12 px-4">
              <FolderTree className="w-12 h-12 text-muted-foreground/50 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground mb-1">No flows yet</p>
              <p className="text-xs text-muted-foreground/70">
                Create your first flow to organize tests
              </p>
            </div>
          ) : matches.length === 0 ? (
            <div className="text-center py-12 px-4">
              <Search className="w-8 h-8 text-muted-foreground/50 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No flows match "{searchQuery}"</p>
              <p className="mt-1 text-xs text-muted-foreground/70">
                Names, and the requests inside each flow, are searched.
              </p>
            </div>
          ) : (
            matches.map(({ flow: group, matchedRequests }) => (
                <div
                  key={group.id}
                  onClick={() => setSelectedFlowId(group.id)}
                  onDoubleClick={() => { setSelectedFlowId(group.id); onOpenFlow(group.id); }}
                  className={`group flex items-center gap-2 h-[var(--rail-row-h)] px-2 rounded-md border cursor-pointer ${
                    selectedFlowId === group.id ? 'bg-primary/10 border-primary/40' : 'border-transparent hover:bg-sidebar-accent'
                  }`}
                >
                  <FolderTree className="w-4 h-4 flex-shrink-0 text-node-group" />
                  <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <span
                      className="truncate text-[13px] font-normal"
                      style={{ color: selectedFlowId === group.id ? undefined : 'hsl(var(--rail-name-color))' }}
                    >
                      {group.name}
                    </span>
                    {/* Why this flow is in a filtered list when its own name does not
                        contain what was typed. Without it the row reads as a bug. */}
                    {matchedRequests.length > 0 && (
                      <span
                        className="shrink-0 truncate text-[10px] text-muted-foreground"
                        title={`Matched: ${matchedRequests.join(", ")}`}
                      >
                        {matchNote(matchedRequests)}
                      </span>
                    )}
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
