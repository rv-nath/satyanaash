import { FileCode, Plus, Edit2, Trash2, MoreVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTestProject } from "@/contexts/TestProjectContext";

interface TestInventoryProps {
  onAddTestCase: () => void;
  onEditTestCase: (test: any) => void;
  onDeleteTestCase: (testId: string) => void;
}

export const TestInventory = ({ onAddTestCase, onEditTestCase, onDeleteTestCase }: TestInventoryProps) => {
  const { testGroups } = useTestProject();

  // Flatten all tests from all groups
  const allTests = testGroups.flatMap(group => 
    group.testCases.map(test => ({
      ...test,
      groupName: group.name,
      groupId: group.id
    }))
  );

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
      <div className="p-4 border-b border-sidebar-border bg-sidebar-accent/30">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-base font-bold text-sidebar-foreground flex items-center gap-2">
              📋 Test Inventory
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {allTests.length} test case{allTests.length !== 1 ? 's' : ''} available
            </p>
          </div>
        </div>
        
        <Button 
          variant="default" 
          size="sm"
          className="w-full gap-2"
          onClick={onAddTestCase}
        >
          <Plus className="w-3 h-3" />
          New Test Case
        </Button>
      </div>

      {/* Test List */}
      <ScrollArea className="flex-1">
        <div className="p-2">
          {allTests.length === 0 ? (
            <div className="text-center py-12 px-4">
              <FileCode className="w-12 h-12 text-muted-foreground/50 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground mb-1">No tests yet</p>
              <p className="text-xs text-muted-foreground/70">
                Create your first test case to get started
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {allTests.map((test) => (
                <div
                  key={test.id}
                  draggable
                  onDragStart={(e) => {
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
                        postTestScript: test.postTestScript
                      }
                    }));
                  }}
                  className="flex items-center gap-2 px-3 py-2.5 hover:bg-sidebar-accent rounded-md transition-colors group cursor-move border border-transparent hover:border-primary/20"
                >
                  <FileCode className="w-4 h-4 text-node-test flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-sidebar-foreground font-medium font-mono truncate">
                      {test.name}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {test.groupName}
                    </div>
                  </div>
                  <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${getMethodColor(test.method)} flex-shrink-0`}>
                    {test.method}
                  </Badge>
                  
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
                      <DropdownMenuItem 
                        className="text-destructive"
                        onClick={() => onDeleteTestCase(test.id)}
                      >
                        <Trash2 className="w-3 h-3 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};
