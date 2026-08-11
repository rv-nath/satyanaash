import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { StepPalette } from "./StepPalette";
import {
  FileCode, Plus, FolderPlus, Edit2, Trash2, MoreVertical, Loader2, Search, X,
  ChevronRight, ChevronDown, Check, Copy,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { useTestProject } from "@/contexts/TestProjectContext";
import {
  useTestCases, useTestGroups, useCreateGroup, useRenameGroup, useDeleteGroup,
  useUpdateTestCase, useCreateTestCase,
} from "@/hooks/useApi";
import { ConfirmDialog } from "@/components/ConfirmDialog";

interface TestInventoryProps {
  onAddTestCase: () => void;
  onEditTestCase: (test: any) => void;
  onDeleteTestCase: (testId: string) => void;
}

interface UiTest {
  id: string;
  name: string;
  method: string;
  endpoint?: string;
  payload?: string;
  postTestScript?: string;
  groupId: string | null;
}

interface GroupLite {
  id: string;
  name: string;
}

const UNGROUPED = "__ungrouped__";

export const TestInventory = ({ onAddTestCase, onEditTestCase, onDeleteTestCase }: TestInventoryProps) => {
  const { projectId, selectedTestCaseId, setSelectedTestCaseId } = useTestProject();

  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Data
  const { data: apiTestCases, isLoading } = useTestCases(projectId || "");
  const { data: apiGroups } = useTestGroups(projectId || "");

  // Mutations
  const createGroup = useCreateGroup();
  const renameGroup = useRenameGroup();
  const deleteGroup = useDeleteGroup();
  const moveTest = useUpdateTestCase();
  const createTestCase = useCreateTestCase();

  // Which group the next top-level "+" (and the empty selection) targets.
  const [focusedGroupId, setFocusedGroupId] = useState<string | null>(null);
  // Group header currently being hovered during a drag (for the drop highlight).
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);

  const groups: GroupLite[] = useMemo(
    () => (apiGroups || []).map((g) => ({ id: g.id, name: g.name })),
    [apiGroups]
  );

  const allTests: UiTest[] = useMemo(
    () =>
      (apiTestCases || []).map((tc) => ({
        id: tc.id,
        name: tc.name,
        method: tc.method,
        endpoint: tc.endpoint,
        payload: tc.payload || undefined,
        postTestScript: tc.assertion_script || undefined,
        groupId: tc.group_id ?? null,
      })),
    [apiTestCases]
  );

  const filteredTests = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return allTests;
    return allTests.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.method.toLowerCase().includes(q) ||
        (t.endpoint?.toLowerCase().includes(q) ?? false)
    );
  }, [allTests, searchQuery]);

  // Group the filtered tests: real groups (newest first) then a virtual Ungrouped.
  const sections = useMemo(() => {
    const byGroup = new Map<string, UiTest[]>();
    for (const t of filteredTests) {
      const key = t.groupId ?? UNGROUPED;
      const arr = byGroup.get(key) ?? [];
      arr.push(t);
      byGroup.set(key, arr);
    }
    const out: { id: string; name: string; tests: UiTest[]; virtual: boolean }[] = [];
    for (const g of groups) {
      out.push({ id: g.id, name: g.name, tests: byGroup.get(g.id) ?? [], virtual: false });
    }
    const ungrouped = byGroup.get(UNGROUPED) ?? [];
    if (ungrouped.length > 0) {
      out.push({ id: UNGROUPED, name: "Ungrouped", tests: ungrouped, virtual: true });
    }
    return out;
  }, [filteredTests, groups]);

  // Flat, render-ordered list for keyboard navigation.
  const orderedTests = useMemo(() => sections.flatMap((s) => s.tests), [sections]);

  // Collapsed state per project (localStorage).
  const storageKey = `sat.groups.collapsed.${projectId || "none"}`;
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
    [storageKey]
  );
  const searching = searchQuery.trim().length > 0;

  // Inline new-group creation.
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const newGroupRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (creatingGroup) newGroupRef.current?.focus();
  }, [creatingGroup]);

  const commitNewGroup = () => {
    const name = newGroupName.trim();
    if (name && projectId) {
      createGroup.mutate(
        { projectId, name },
        {
          onSuccess: () => toast.success(`Created group "${name}"`),
          // The server's own words. A duplicate name comes back as a 409 saying which
          // name is taken, and "Failed to create group" threw that away — the same
          // discarding that once made every API error in this app read "Unknown error".
          onError: (e: Error) => {
            toast.error(e.message || "Failed to create group");
            // Hand the field back with what was typed, rather than making the author
            // retype a name that was refused for one fixable reason.
            setCreatingGroup(true);
            setNewGroupName(name);
          },
        }
      );
    }
    setCreatingGroup(false);
    setNewGroupName("");
  };

  // Inline group rename.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const commitRename = () => {
    const name = renameValue.trim();
    if (renamingId && name && projectId) {
      const wasRenaming = renamingId;
      renameGroup.mutate(
        { id: renamingId, name, projectId },
        {
          onError: (e: Error) => {
            toast.error(e.message || "Failed to rename group");
            setRenamingId(wasRenaming);
            setRenameValue(name);
          },
        }
      );
    }
    setRenamingId(null);
    setRenameValue("");
  };

  // Confirmation dialog (shared for group + test deletes)
  const [pendingConfirm, setPendingConfirm] = useState<
    { title: string; description: React.ReactNode; onConfirm: () => void } | null
  >(null);

  const handleDeleteGroup = (id: string, name: string) => {
    if (!projectId) return;
    setPendingConfirm({
      title: "Delete group?",
      description: `"${name}" will be deleted. Its test cases move to Ungrouped.`,
      onConfirm: () =>
        deleteGroup.mutate(
          { id, projectId },
          {
            onSuccess: () => toast.success(`Deleted "${name}" — its tests moved to Ungrouped`),
            onError: () => toast.error("Failed to delete group"),
          }
        ),
    });
  };

  const requestDeleteTest = (test: UiTest) =>
    setPendingConfirm({
      title: "Delete test case?",
      description: `"${test.name}" will be deleted. This can't be undone.`,
      onConfirm: () => onDeleteTestCase(test.id),
    });

  const handleMoveTest = (testId: string, groupId: string) => {
    if (!projectId) return;
    moveTest.mutate(
      { id: testId, data: { group_id: groupId }, projectId },
      {
        onSuccess: () => setSelectedTestCaseId(testId),
        onError: () => toast.error("Failed to move test"),
      }
    );
  };

  // Create a blank test case already inside `groupId` and open it in the editor.
  const handleCreateInGroup = (groupId: string) => {
    if (!projectId) return;
    createTestCase.mutate(
      { projectId, data: { name: "New request", method: "GET", endpoint: "", group_id: groupId } },
      {
        onSuccess: (tc) =>
          onEditTestCase({
            id: tc.id,
            name: tc.name,
            method: tc.method,
            endpoint: tc.endpoint,
            groupId: tc.group_id ?? null,
          }),
        onError: () => toast.error("Failed to create test case"),
      }
    );
  };

  // Duplicate a test case (all fields) into the same group.
  const handleClone = (testId: string) => {
    const tc = (apiTestCases || []).find((t) => t.id === testId);
    if (!tc || !projectId) return;
    createTestCase.mutate(
      {
        projectId,
        data: {
          name: `${tc.name} copy`,
          group_id: tc.group_id ?? undefined,
          given_condition: tc.given_condition ?? undefined,
          when_action: tc.when_action ?? undefined,
          then_expected: tc.then_expected ?? undefined,
          method: tc.method,
          endpoint: tc.endpoint,
          headers: tc.headers,
          payload: tc.payload ?? undefined,
          exports: tc.exports,
          assertion_script: tc.assertion_script ?? undefined,
          pre_test_script: tc.pre_test_script ?? undefined,
          dataset: tc.dataset ?? undefined,
        },
      },
      {
        onSuccess: () => toast.success(`Cloned "${tc.name}"`),
        onError: () => toast.error("Failed to clone test"),
      }
    );
  };

  const handleClick = useCallback((id: string) => setSelectedTestCaseId(id), [setSelectedTestCaseId]);
  const handleDoubleClick = useCallback(
    (id: string) => {
      const t = allTests.find((x) => x.id === id);
      if (t) onEditTestCase(t);
    },
    [allTests, onEditTestCase]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (orderedTests.length === 0) return;
      const i = orderedTests.findIndex((t) => t.id === selectedTestCaseId);
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          if (i < orderedTests.length - 1) setSelectedTestCaseId(orderedTests[i + 1].id);
          else if (i === -1) setSelectedTestCaseId(orderedTests[0].id);
          break;
        case "ArrowUp":
          e.preventDefault();
          if (i > 0) setSelectedTestCaseId(orderedTests[i - 1].id);
          break;
        case "Enter":
          e.preventDefault();
          if (selectedTestCaseId) {
            const t = orderedTests.find((x) => x.id === selectedTestCaseId);
            if (t) onEditTestCase(t);
          }
          break;
        case "Escape":
          e.preventDefault();
          setSelectedTestCaseId(null);
          searchInputRef.current?.blur();
          break;
      }
    },
    [orderedTests, selectedTestCaseId, setSelectedTestCaseId, onEditTestCase]
  );

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
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Tests</span>
          <span className="text-[10px] text-muted-foreground/60">
            {filteredTests.length === allTests.length ? allTests.length : `${filteredTests.length}/${allTests.length}`}
          </span>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => {
              setNewGroupName("");
              setCreatingGroup(true);
            }}
            title="New group"
          >
            <FolderPlus className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => (focusedGroupId ? handleCreateInGroup(focusedGroupId) : onAddTestCase())}
            title={focusedGroupId ? "New test case in focused group" : "New test case"}
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
            placeholder="Search tests..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="pl-8 pr-8 h-7 text-xs"
          />
          {searchQuery && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-3 top-1/2 -translate-y-1/2 h-6 w-6"
              onClick={() => setSearchQuery("")}
            >
              <X className="w-3 h-3" />
            </Button>
          )}
        </div>
      </div>

      {/* Steps that are not test cases. Above the list rather than inside it: a control node is
          not a test case and does not belong in a count of them. */}
      <div className="border-b border-sidebar-border pt-2">
        <StepPalette />
      </div>

      {/* List */}
      <ScrollArea className="flex-1">
        <div ref={listRef} className="p-2" tabIndex={0} onKeyDown={handleKeyDown}>
          {/* Inline new-group row (top) */}
          {creatingGroup && (
            <div className="flex items-center gap-1.5 h-7 px-1 mb-0.5">
              <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
              <Input
                ref={newGroupRef}
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                onBlur={commitNewGroup}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitNewGroup();
                  if (e.key === "Escape") {
                    setCreatingGroup(false);
                    setNewGroupName("");
                  }
                }}
                placeholder="New group name…"
                className="h-6 text-xs font-medium"
              />
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : allTests.length === 0 && !creatingGroup ? (
            <div className="text-center py-12 px-4">
              <FileCode className="w-12 h-12 text-muted-foreground/50 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground mb-1">No tests yet</p>
              <p className="text-xs text-muted-foreground/70">Create your first test case to get started</p>
            </div>
          ) : filteredTests.length === 0 && searching ? (
            <div className="text-center py-8 px-4">
              <Search className="w-8 h-8 text-muted-foreground/50 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No matching tests</p>
              <p className="text-xs text-muted-foreground/70 mt-1">Try a different search term</p>
            </div>
          ) : (
            sections.map((section) => {
              const isCollapsed = !searching && collapsed.has(section.id);
              return (
                <div key={section.id} className="mb-0.5">
                  {/* Group header (also a drop target for moving tests here) */}
                  <div
                    className={`group/gh flex items-center gap-1.5 h-7 px-1 rounded-md hover:bg-sidebar-accent ${
                      dragOverGroupId === section.id ? "ring-1 ring-primary bg-primary/5" : ""
                    }`}
                    onDragOver={(e) => {
                      if (section.virtual) return; // move-to-Ungrouped not supported yet
                      e.preventDefault();
                      setDragOverGroupId(section.id);
                    }}
                    onDragLeave={() => setDragOverGroupId((cur) => (cur === section.id ? null : cur))}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOverGroupId(null);
                      if (section.virtual) return;
                      try {
                        const payload = JSON.parse(e.dataTransfer.getData("application/json"));
                        if (payload?.type === "testCase" && payload.testCaseId) {
                          handleMoveTest(payload.testCaseId, section.id);
                        }
                      } catch {
                        /* not a test-case drag */
                      }
                    }}
                  >
                    <button
                      className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
                      onClick={() => {
                        toggleCollapsed(section.id);
                        setFocusedGroupId(section.virtual ? null : section.id);
                      }}
                    >
                      {isCollapsed ? (
                        <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
                      ) : (
                        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
                      )}
                      {renamingId === section.id ? (
                        <Input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename();
                            if (e.key === "Escape") {
                              setRenamingId(null);
                              setRenameValue("");
                            }
                          }}
                          className="h-6 text-xs font-medium"
                        />
                      ) : (
                        <span
                          className={`truncate text-xs font-medium ${
                            section.virtual ? "italic text-muted-foreground/70" : "text-muted-foreground"
                          }`}
                        >
                          {section.name}
                        </span>
                      )}
                    </button>
                    <span className="text-[10px] text-muted-foreground/50 shrink-0">{section.tests.length}</span>
                    {!section.virtual && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5 opacity-0 group-hover/gh:opacity-100 shrink-0"
                          >
                            <MoreVertical className="w-3 h-3" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleCreateInGroup(section.id)}>
                            <Plus className="w-3 h-3 mr-2" />
                            New test case
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => {
                              setRenamingId(section.id);
                              setRenameValue(section.name);
                            }}
                          >
                            <Edit2 className="w-3 h-3 mr-2" />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => handleDeleteGroup(section.id, section.name)}
                          >
                            <Trash2 className="w-3 h-3 mr-2" />
                            Delete group
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>

                  {/* Group body */}
                  {!isCollapsed && (
                    <div className="pl-3 space-y-0.5 mt-0.5">
                      {section.tests.length === 0 ? (
                        <p className="text-[11px] text-muted-foreground/50 italic px-2 py-1">Empty</p>
                      ) : (
                        section.tests.map((test) => (
                          <TestRow
                            key={test.id}
                            test={test}
                            groups={groups}
                            isSelected={selectedTestCaseId === test.id}
                            onClick={() => {
                              handleClick(test.id);
                              setFocusedGroupId(test.groupId);
                            }}
                            onDoubleClick={() => handleDoubleClick(test.id)}
                            onEditTestCase={onEditTestCase}
                            onRequestDelete={requestDeleteTest}
                            onMove={handleMoveTest}
                            onClone={handleClone}
                            getMethodColor={getMethodColor}
                          />
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>

      {/* Keyboard hint */}
      {selectedTestCaseId && (
        <div className="px-4 py-2 border-t border-sidebar-border bg-sidebar-accent/20">
          <p className="text-[10px] text-muted-foreground text-center">
            Press <kbd className="px-1 py-0.5 bg-muted rounded text-[9px]">Enter</kbd> to edit •{" "}
            <kbd className="px-1 py-0.5 bg-muted rounded text-[9px]">↑↓</kbd> to navigate
          </p>
        </div>
      )}

      {pendingConfirm && (
        <ConfirmDialog
          open
          onOpenChange={(o) => { if (!o) setPendingConfirm(null); }}
          title={pendingConfirm.title}
          description={pendingConfirm.description}
          onConfirm={() => { pendingConfirm.onConfirm(); setPendingConfirm(null); }}
        />
      )}
    </div>
  );
};

const getMethodColor = (method: string) => {
  const colors: Record<string, string> = {
    GET: "bg-success/20 text-success",
    POST: "bg-primary/20 text-primary",
    PUT: "bg-warning/20 text-warning",
    DELETE: "bg-destructive/20 text-destructive",
    PATCH: "bg-accent/20 text-accent",
  };
  return colors[method] || "bg-muted";
};

interface TestRowProps {
  test: UiTest;
  groups: GroupLite[];
  isSelected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onEditTestCase: (test: UiTest) => void;
  onRequestDelete: (test: UiTest) => void;
  onMove: (testId: string, groupId: string) => void;
  onClone: (testId: string) => void;
  getMethodColor: (method: string) => string;
}

const TestRow = ({
  test, groups, isSelected, onClick, onDoubleClick, onEditTestCase, onRequestDelete, onMove, onClone, getMethodColor,
}: TestRowProps) => {
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(
      "application/json",
      JSON.stringify({
        type: "testCase",
        testCaseId: test.id,
        data: {
          testCaseId: test.id,
          label: test.name,
          method: test.method,
          endpoint: test.endpoint,
          payload: test.payload,
          postTestScript: test.postTestScript,
        },
      })
    );
  };

  return (
    <div
      draggable
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onDragStart={handleDragStart}
      className={`group flex items-center gap-2 h-[var(--rail-row-h)] px-2 rounded-md border cursor-pointer ${
        isSelected ? "bg-primary/10 border-primary/40" : "border-transparent hover:bg-sidebar-accent"
      }`}
    >
      <Badge variant="secondary" className={`text-[9px] px-1.5 py-0 flex-shrink-0 ${getMethodColor(test.method)}`}>
        {test.method}
      </Badge>
      <span
        className="flex-1 truncate text-[13px] font-normal"
        style={{ color: isSelected ? undefined : "hsl(var(--rail-name-color))" }}
      >
        {test.name}
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 flex-shrink-0 opacity-0 group-hover:opacity-100"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreVertical className="w-3 h-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onEditTestCase(test)}>
            <Edit2 className="w-3 h-3 mr-2" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onClone(test.id)}>
            <Copy className="w-3 h-3 mr-2" />
            Clone
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderPlus className="w-3 h-3 mr-2" />
              Move to group
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {groups.length === 0 ? (
                <DropdownMenuItem disabled>No groups yet</DropdownMenuItem>
              ) : (
                groups.map((g) => (
                  <DropdownMenuItem
                    key={g.id}
                    onClick={() => onMove(test.id, g.id)}
                    disabled={test.groupId === g.id}
                  >
                    {test.groupId === g.id ? (
                      <Check className="w-3 h-3 mr-2 text-primary" />
                    ) : (
                      <span className="w-3 mr-2" />
                    )}
                    {g.name}
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive" onClick={() => onRequestDelete(test)}>
            <Trash2 className="w-3 h-3 mr-2" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
