import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FolderTree,
  Plus,
  Edit2,
  Trash2,
  MoreVertical,
  Copy,
  Search,
  X,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTestProject } from "@/contexts/TestProjectContext";
import { filterFlows, matchNote } from "@/lib/flowSearch";
import { UNGROUPED, bucketsOf, collapseKey, dropTarget } from "@/lib/flowGrouping";
import {
  useCreateFlowGroup,
  useDeleteFlowGroup,
  useFlowGroups,
  useMoveFlowToGroup,
  useRenameFlowGroup,
} from "@/hooks/useApi";

interface FlowsListProps {
  onOpenFlow: (flowId: string) => void;
  onAddGroup: () => void;
  onEditGroup: (group: any) => void;
  onCloneGroup: (groupId: string) => void;
  onDeleteGroup: (groupId: string) => void;
}

export const FlowsList = ({ onOpenFlow, onAddGroup, onEditGroup, onCloneGroup, onDeleteGroup }: FlowsListProps) => {
  const { flows, projectId, setFlowGroup } = useTestProject();
  const { data: groups = [] } = useFlowGroups(projectId || "");
  const createGroup = useCreateFlowGroup();
  const renameGroup = useRenameFlowGroup();
  const deleteGroupMutation = useDeleteFlowGroup();
  const moveFlow = useMoveFlowToGroup();
  // Single click selects (highlights); double click opens — mirrors the tests rail.
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => filterFlows(flows, searchQuery), [flows, searchQuery]);
  const searching = searchQuery.trim().length > 0;

  // Buckets over the *filtered* flows, so searching narrows within each group rather than
  // flattening the list — the shape you are used to is the shape you search in.
  const buckets = useMemo(
    () => bucketsOf(matches.map((m) => ({ ...m, id: m.flow.id, groupId: m.flow.groupId })), groups),
    [matches, groups],
  );

  // Collapsed buckets, per project. Ignored while searching: a hit inside a collapsed group
  // would otherwise be a result you cannot see.
  const storageKey = collapseKey(projectId);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem(storageKey) || "[]"));
    } catch {
      return new Set<string>();
    }
  });
  const toggleCollapsed = useCallback(
    (id: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        localStorage.setItem(storageKey, JSON.stringify([...next]));
        return next;
      });
    },
    [storageKey],
  );

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [pendingGroupDelete, setPendingGroupDelete] = useState<{ id: string; name: string } | null>(
    null,
  );

  const submitNewGroup = () => {
    const name = newName.trim();
    if (!name || !projectId) {
      setCreating(false);
      setNewName("");
      return;
    }
    createGroup.mutate(
      { projectId, name },
      {
        onSuccess: () => {
          setCreating(false);
          setNewName("");
        },
        // The server refuses a duplicate name and says which — throwing that away and saying
        // "failed" would lose the only useful part.
        onError: (e: Error) => toast.error(e.message || "Could not create the group"),
      },
    );
  };

  const submitRename = () => {
    if (!renaming || !projectId) return;
    const name = renaming.name.trim();
    if (!name) return setRenaming(null);
    renameGroup.mutate(
      { id: renaming.id, name, projectId },
      {
        onSuccess: () => setRenaming(null),
        onError: (e: Error) => toast.error(e.message || "Could not rename the group"),
      },
    );
  };

  const handleDrop = (bucketId: string, flowId: string) => {
    const flow = flows.find((f) => f.id === flowId);
    if (!flow || !projectId) return;
    const target = dropTarget(bucketId, flow.groupId);
    // Dropped where it already was: nothing to say to the server.
    if (target === undefined) return;
    // Moved locally first so the row lands under the cursor, then persisted. Not a query
    // invalidation — see `setFlowGroup`.
    setFlowGroup(flowId, target);
    moveFlow.mutate(
      { flowId, groupId: target },
      {
        onError: (e: Error) => {
          // Put it back. A row that stays where you dropped it while the server disagrees is
          // the worst outcome: you would only find out on the next reload.
          setFlowGroup(flowId, flow.groupId ?? null);
          toast.error(e.message || "Could not move the flow");
        },
      },
    );
  };

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
          {matches.length === flows.length
            ? flows.length
            : `${matches.length}/${flows.length}`}
        </span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => {
            setCreating(true);
            // A new group starts expanded, or the first flow dropped into it disappears.
            setCollapsed((prev) => {
              const next = new Set(prev);
              next.delete(UNGROUPED);
              return next;
            });
          }}
          title="New group"
        >
          <FolderPlus className="w-3.5 h-3.5" />
        </Button>
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
          {flows.length === 0 ? (
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
            buckets.map((bucket) => {
              const isCollapsed = !searching && collapsed.has(bucket.id);
              const renamingThis = renaming?.id === bucket.id;
              return (
                <div key={bucket.id} className="mb-0.5">
                  {/* The heading is the drop target. Ungrouped is one too — dropping there means
                      "no group", which is a real move rather than the no-op it is in the tests
                      rail. */}
                  <div
                    className={`group/gh flex items-center gap-1.5 h-7 px-1 rounded-md hover:bg-sidebar-accent ${
                      dragOver === bucket.id ? "ring-1 ring-primary bg-primary/5" : ""
                    }`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOver(bucket.id);
                    }}
                    onDragLeave={() =>
                      setDragOver((cur) => (cur === bucket.id ? null : cur))
                    }
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOver(null);
                      try {
                        const payload = JSON.parse(e.dataTransfer.getData("application/json"));
                        if (payload?.type === "flow" && payload.flowId) {
                          handleDrop(bucket.id, payload.flowId);
                        }
                      } catch {
                        /* not a flow drag — a test case dragged from the other rail lands here */
                      }
                    }}
                  >
                    {renamingThis ? (
                      <Input
                        autoFocus
                        value={renaming.name}
                        onChange={(e) => setRenaming({ id: bucket.id, name: e.target.value })}
                        onBlur={submitRename}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") submitRename();
                          if (e.key === "Escape") setRenaming(null);
                        }}
                        className="h-6 text-xs"
                        aria-label={`Rename ${bucket.name}`}
                      />
                    ) : (
                      <>
                        <button
                          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                          onClick={() => toggleCollapsed(bucket.id)}
                          aria-expanded={!isCollapsed}
                        >
                          {isCollapsed ? (
                            <ChevronRight className="w-3.5 h-3.5 shrink-0 text-muted-foreground/50" />
                          ) : (
                            <ChevronDown className="w-3.5 h-3.5 shrink-0 text-muted-foreground/50" />
                          )}
                          <span
                            className={`truncate text-[11px] font-semibold uppercase tracking-wider ${
                              bucket.virtual ? "text-muted-foreground/60" : "text-muted-foreground"
                            }`}
                          >
                            {bucket.name}
                          </span>
                          <span className="shrink-0 text-[10px] text-muted-foreground/60">
                            {bucket.flows.length}
                          </span>
                        </button>
                        {/* Ungrouped has no row in the database, so there is nothing to rename
                            or delete. */}
                        {!bucket.virtual && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-5 w-5 opacity-0 group-hover/gh:opacity-100"
                                aria-label={`${bucket.name} group actions`}
                              >
                                <MoreVertical className="w-3 h-3" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => setRenaming({ id: bucket.id, name: bucket.name })}
                              >
                                <Edit2 className="w-3 h-3 mr-2" />
                                Rename group
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={() =>
                                  setPendingGroupDelete({ id: bucket.id, name: bucket.name })
                                }
                              >
                                <Trash2 className="w-3 h-3 mr-2" />
                                Delete group
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </>
                    )}
                  </div>

                  {/* An empty real group says what to do with it, so a bucket you just made is
                      not a blank line you wonder about. */}
                  {!isCollapsed && bucket.flows.length === 0 && !bucket.virtual && (
                    <p className="px-6 py-1.5 text-[11px] italic text-muted-foreground/60">
                      Empty — drag a flow here
                    </p>
                  )}

                  {!isCollapsed &&
                    bucket.flows.map(({ flow: group, matchedRequests }) => (
                <div
                  key={group.id}
                  draggable
                  onDragStart={(e) =>
                    e.dataTransfer.setData(
                      "application/json",
                      // Additive: the flat `flowId` is what this rail's own bucket drop
                      // target reads, and `data` is what the canvas passes to
                      // `addNodeToCanvas`. Dropping one for the other breaks the other target.
                      JSON.stringify({
                        type: "flow",
                        flowId: group.id,
                        data: { flowId: group.id, label: group.name },
                      }),
                    )
                  }
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
                    ))}
                </div>
              );
            })
          )}

          {/* Inline, at the bottom, so creating a group does not move the list under you. */}
          {creating && (
            <div className="mt-1 flex items-center gap-1.5 px-1">
              <FolderPlus className="w-3.5 h-3.5 shrink-0 text-muted-foreground/50" />
              <Input
                autoFocus
                value={newName}
                placeholder="Group name"
                onChange={(e) => setNewName(e.target.value)}
                onBlur={submitNewGroup}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitNewGroup();
                  if (e.key === "Escape") {
                    setCreating(false);
                    setNewName("");
                  }
                }}
                className="h-6 text-xs"
                aria-label="New group name"
              />
              <Check className="w-3.5 h-3.5 shrink-0 text-muted-foreground/50" />
            </div>
          )}
        </div>
      </ScrollArea>

      {pendingGroupDelete && (
        <ConfirmDialog
          open
          onOpenChange={(o) => { if (!o) setPendingGroupDelete(null); }}
          title="Delete group?"
          // Says what survives. Tidying the sidebar is not a reason to lose a flow, and this is
          // the sentence that makes that obvious before the click rather than after.
          description={`"${pendingGroupDelete.name}" will be deleted. Its flows move to Ungrouped — nothing is lost.`}
          onConfirm={() => {
            const id = pendingGroupDelete.id;
            if (projectId) {
              deleteGroupMutation.mutate(
                { id, projectId },
                { onError: (e: Error) => toast.error(e.message || "Could not delete the group") },
              );
            }
            // The server nulls group_id for these; mirror it locally rather than refetching the
            // flows, for the reason in `setFlowGroup`.
            flows.filter((f) => f.groupId === id).forEach((f) => setFlowGroup(f.id, null));
            setPendingGroupDelete(null);
          }}
        />
      )}

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
