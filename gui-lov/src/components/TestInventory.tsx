import { useState, useRef, useEffect, useCallback } from "react";
import { FileCode, Plus, Edit2, Trash2, MoreVertical, Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTestProject } from "@/contexts/TestProjectContext";
import { useTestCases } from "@/hooks/useApi";
import { TestRowPopover } from "@/components/TestRowPopover";

interface TestInventoryProps {
  onAddTestCase: () => void;
  onEditTestCase: (test: any) => void;
  onDeleteTestCase: (testId: string) => void;
}

export const TestInventory = ({ onAddTestCase, onEditTestCase, onDeleteTestCase }: TestInventoryProps) => {
  const { projectId, testGroups, activeFlowId, selectedTestCaseId, setSelectedTestCaseId } = useTestProject();

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Fetch test cases from API
  const { data: apiTestCases, isLoading } = useTestCases(projectId || '');

  // Map API test cases to UI format
  const allTests = (apiTestCases || []).map(tc => ({
    id: tc.id,
    name: tc.name,
    method: tc.method as "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
    endpoint: tc.endpoint,
    headers: tc.headers ? JSON.stringify(tc.headers) : undefined,
    payload: tc.payload || undefined,
    postTestScript: tc.assertion_script || undefined,
    groupName: "Project Tests",  // Test cases belong to project, not flows
    groupId: activeFlowId || testGroups[0]?.id || ""  // Default to active flow for UI
  }));

  // Filter tests by search query
  const filteredTests = allTests.filter(test => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    return (
      test.name.toLowerCase().includes(query) ||
      test.method.toLowerCase().includes(query) ||
      (test.endpoint?.toLowerCase().includes(query) ?? false)
    );
  });

  // Handle single click - select only
  const handleClick = useCallback((testId: string) => {
    setSelectedTestCaseId(testId);
  }, [setSelectedTestCaseId]);

  // Handle double click - open in editor
  const handleDoubleClick = useCallback((testId: string) => {
    const test = allTests.find(t => t.id === testId);
    if (test) {
      onEditTestCase(test);
    }
  }, [allTests, onEditTestCase]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (filteredTests.length === 0) return;

    const currentIndex = filteredTests.findIndex(t => t.id === selectedTestCaseId);

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (currentIndex < filteredTests.length - 1) {
          setSelectedTestCaseId(filteredTests[currentIndex + 1].id);
        } else if (currentIndex === -1 && filteredTests.length > 0) {
          setSelectedTestCaseId(filteredTests[0].id);
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (currentIndex > 0) {
          setSelectedTestCaseId(filteredTests[currentIndex - 1].id);
        }
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedTestCaseId) {
          const test = filteredTests.find(t => t.id === selectedTestCaseId);
          if (test) {
            onEditTestCase(test);
          }
        }
        break;
      case 'Escape':
        e.preventDefault();
        setSelectedTestCaseId(null);
        searchInputRef.current?.blur();
        break;
    }
  }, [filteredTests, selectedTestCaseId, setSelectedTestCaseId, onEditTestCase]);

  // Focus search with Ctrl+F or Cmd+F when component is focused
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        if (listRef.current?.contains(document.activeElement) ||
            searchInputRef.current?.contains(document.activeElement as Node)) {
          e.preventDefault();
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        }
      }
    };

    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

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

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="border-b border-sidebar-border">
        <div className="flex items-center gap-2 h-8 px-3">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Tests
          </span>
          <span className="text-[10px] text-muted-foreground/60">
            {filteredTests.length === allTests.length
              ? allTests.length
              : `${filteredTests.length}/${allTests.length}`}
          </span>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onAddTestCase}
            title="New test case"
          >
            <Plus className="w-3.5 h-3.5" />
          </Button>
        </div>

        {/* Search input */}
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

      {/* Test List */}
      <ScrollArea className="flex-1">
        <div ref={listRef} className="p-2" tabIndex={0} onKeyDown={handleKeyDown}>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : allTests.length === 0 ? (
            <div className="text-center py-12 px-4">
              <FileCode className="w-12 h-12 text-muted-foreground/50 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground mb-1">No tests yet</p>
              <p className="text-xs text-muted-foreground/70">
                Create your first test case to get started
              </p>
            </div>
          ) : filteredTests.length === 0 ? (
            <div className="text-center py-8 px-4">
              <Search className="w-8 h-8 text-muted-foreground/50 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No matching tests</p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                Try a different search term
              </p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {filteredTests.map((test) => (
                <TestRow
                  key={test.id}
                  test={test}
                  isSelected={selectedTestCaseId === test.id}
                  onClick={() => handleClick(test.id)}
                  onDoubleClick={() => handleDoubleClick(test.id)}
                  onEditTestCase={onEditTestCase}
                  onDeleteTestCase={onDeleteTestCase}
                  getMethodColor={getMethodColor}
                />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Keyboard hint */}
      {selectedTestCaseId && (
        <div className="px-4 py-2 border-t border-sidebar-border bg-sidebar-accent/20">
          <p className="text-[10px] text-muted-foreground text-center">
            Press <kbd className="px-1 py-0.5 bg-muted rounded text-[9px]">Enter</kbd> to edit
            • <kbd className="px-1 py-0.5 bg-muted rounded text-[9px]">↑↓</kbd> to navigate
          </p>
        </div>
      )}
    </div>
  );
};

interface TestRowData {
  id: string;
  name: string;
  method: string;
  endpoint?: string;
  payload?: string;
  preTestScript?: string;
  postTestScript?: string;
}

interface TestRowProps {
  test: TestRowData;
  isSelected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onEditTestCase: (test: TestRowData) => void;
  onDeleteTestCase: (testId: string) => void;
  getMethodColor: (method: string) => string;
}

const TestRow = ({
  test, isSelected, onClick, onDoubleClick, onEditTestCase, onDeleteTestCase, getMethodColor,
}: TestRowProps) => {
  const nameRef = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('application/json', JSON.stringify({
      type: 'testCase',
      testCaseId: test.id,
      data: {
        testCaseId: test.id,
        label: test.name,
        method: test.method,
        endpoint: test.endpoint,
        payload: test.payload,
        preTestScript: test.preTestScript,
        postTestScript: test.postTestScript,
      },
    }));
  };

  return (
    <div
      draggable
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onDragStart={handleDragStart}
      className={`group flex items-center gap-2 h-[var(--rail-row-h)] px-2 rounded-md border cursor-pointer ${
        isSelected ? 'bg-primary/10 border-primary/40' : 'border-transparent hover:bg-sidebar-accent'
      }`}
    >
      <Badge variant="secondary" className={`text-[9px] px-1.5 py-0 flex-shrink-0 ${getMethodColor(test.method)}`}>
        {test.method}
      </Badge>
      <span
        ref={nameRef}
        className="flex-1 truncate text-[13px] font-normal"
        style={{ color: isSelected ? undefined : 'hsl(var(--rail-name-color))' }}
      >
        {test.name}
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100 flex-shrink-0">
            <MoreVertical className="w-3 h-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onEditTestCase(test)}>
            <Edit2 className="w-3 h-3 mr-2" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem className="text-destructive" onClick={() => onDeleteTestCase(test.id)}>
            <Trash2 className="w-3 h-3 mr-2" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <TestRowPopover
        anchorRef={nameRef}
        method={test.method}
        endpoint={test.endpoint || ""}
        open={hovered}
      />
    </div>
  );
};
