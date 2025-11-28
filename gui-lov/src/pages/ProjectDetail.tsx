import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { 
  ArrowLeft, Play, Pause, RotateCcw, Settings, CheckCircle2, Download, ChevronDown, Bug
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { 
  ResizableHandle, 
  ResizablePanel, 
  ResizablePanelGroup 
} from "@/components/ui/resizable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import TestCanvas from "@/components/TestCanvas";
import ConsolePanel from "@/components/ConsolePanel";
import { TestProjectProvider, useTestProject } from "@/contexts/TestProjectContext";
import { TestGroupDialog } from "@/components/TestGroupDialog";
import { TestCaseDialog } from "@/components/TestCaseDialog";
import { TestInventory } from "@/components/TestInventory";
import { FlowsList } from "@/components/FlowsList";
import { FlowValidator } from "@/components/FlowValidator";

const ProjectDetailContent = () => {
  const { id } = useParams();
  const { 
    testGroups, 
    nodes,
    edges,
    activeFlowId,
    showConsole,
    setShowConsole,
    toggleGroup, 
    addTestGroup, 
    updateTestGroup,
    deleteTestGroup,
    addTestCase, 
    updateTestCase,
    deleteTestCase,
    exportFlowJSON
  } = useTestProject();
  
  const [isExecuting, setIsExecuting] = useState(false);
  const [consoleLogs, setConsoleLogs] = useState<Array<{ timestamp: string; message: string; type: "info" | "success" | "error" }>>([
    { timestamp: new Date().toISOString(), message: "Ready to execute tests", type: "info" }
  ]);

  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [testCaseDialogOpen, setTestCaseDialogOpen] = useState(false);
  const [validatorOpen, setValidatorOpen] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string>("");
  const [editingGroup, setEditingGroup] = useState<{ id: string; name: string; description?: string } | null>(null);
  const [editingTestCase, setEditingTestCase] = useState<{ id: string; name: string; method: any; endpoint?: string } | null>(null);

  const handleExecute = (mode: "run" | "debug" = "run") => {
    setIsExecuting(true);
    const log = { 
      timestamp: new Date().toISOString(), 
      message: `Starting ${mode === "debug" ? "debug" : "test"} execution...`, 
      type: "info" as const 
    };
    setConsoleLogs(prev => [...prev, log]);
    
    // Simulate test execution
    setTimeout(() => {
      setConsoleLogs(prev => [...prev, { 
        timestamp: new Date().toISOString(), 
        message: "✓ POST /login - Valid credentials (201ms)", 
        type: "success" 
      }]);
    }, 500);

    setTimeout(() => {
      setConsoleLogs(prev => [...prev, { 
        timestamp: new Date().toISOString(), 
        message: "✓ POST /login - Invalid password (156ms)", 
        type: "success" 
      }]);
    }, 1000);

    setTimeout(() => {
      setIsExecuting(false);
      setConsoleLogs(prev => [...prev, { 
        timestamp: new Date().toISOString(), 
        message: "Execution complete: 2 passed, 0 failed", 
        type: "success" 
      }]);
      toast.success("Test execution complete");
    }, 1500);
  };

  const handleExportFlow = () => {
    if (!activeFlowId) {
      toast.error("No flow selected");
      return;
    }

    const flowJSON = exportFlowJSON(activeFlowId);
    if (!flowJSON) {
      toast.error("Failed to export flow");
      return;
    }

    const blob = new Blob([JSON.stringify(flowJSON, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${flowJSON.name.replace(/\s+/g, '-').toLowerCase()}-flow.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    toast.success("Flow exported successfully");
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border bg-card px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="w-4 h-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-lg font-semibold font-mono text-foreground">Auth API Tests</h1>
            <p className="text-xs text-muted-foreground">24 tests · 3 groups</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setValidatorOpen(true)}
            className="gap-2"
          >
            <CheckCircle2 className="w-4 h-4" />
            Validate
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportFlow}
            disabled={!activeFlowId}
            className="gap-2"
          >
            <Download className="w-4 h-4" />
            Export JSON
          </Button>
          <DropdownMenu>
            <div className="flex">
              <Button
                onClick={() => handleExecute("run")}
                disabled={isExecuting}
                className="gap-2 rounded-r-none"
              >
                {isExecuting ? (
                  <>
                    <Pause className="w-4 h-4" />
                    Executing...
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4" />
                    Run Tests
                  </>
                )}
              </Button>
              <DropdownMenuTrigger asChild>
                <Button
                  disabled={isExecuting}
                  className="rounded-l-none border-l border-primary-foreground/20 px-2"
                >
                  <ChevronDown className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
            </div>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => handleExecute("run")}>
                <Play className="w-4 h-4 mr-2" />
                Run
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExecute("debug")}>
                <Bug className="w-4 h-4 mr-2" />
                Debug
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" size="icon">
            <RotateCcw className="w-4 h-4" />
          </Button>
          <Button variant="outline" size="icon">
            <Settings className="w-4 h-4" />
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <ResizablePanelGroup direction="horizontal" className="flex-1">
        {/* Left Panel with Tabs */}
        <ResizablePanel defaultSize={35} minSize={25} maxSize={45}>
          <div className="h-full bg-sidebar border-r border-sidebar-border">
            <Tabs defaultValue="tests" className="h-full flex flex-col">
              <div className="border-b border-sidebar-border px-4 pt-4">
                <TabsList className="w-full">
                  <TabsTrigger value="tests" className="flex-1">Tests</TabsTrigger>
                  <TabsTrigger value="flows" className="flex-1">Flows</TabsTrigger>
                </TabsList>
              </div>
              
              <TabsContent value="tests" className="flex-1 mt-0">
                <TestInventory
                  onAddTestCase={() => {
                    setSelectedGroupId(activeFlowId || testGroups[0]?.id || "");
                    setTestCaseDialogOpen(true);
                  }}
                  onEditTestCase={(test) => {
                    setEditingTestCase({ 
                      id: test.id, 
                      name: test.name, 
                      method: test.method,
                      endpoint: test.endpoint 
                    });
                    setSelectedGroupId(test.groupId);
                    setTestCaseDialogOpen(true);
                  }}
                  onDeleteTestCase={deleteTestCase}
                />
              </TabsContent>
              
              <TabsContent value="flows" className="flex-1 mt-0">
                <FlowsList
                  onAddGroup={() => setGroupDialogOpen(true)}
                  onEditGroup={(group) => {
                    setEditingGroup({ id: group.id, name: group.name, description: group.description });
                    setGroupDialogOpen(true);
                  }}
                  onDeleteGroup={deleteTestGroup}
                  onAddTestCaseToGroup={(groupId) => {
                    setSelectedGroupId(groupId);
                    setTestCaseDialogOpen(true);
                  }}
                />
              </TabsContent>
            </Tabs>
          </div>
        </ResizablePanel>

        <ResizableHandle />

        {/* Canvas & Console */}
        <ResizablePanel defaultSize={80}>
          {showConsole ? (
            <ResizablePanelGroup direction="vertical">
              {/* Canvas */}
              <ResizablePanel defaultSize={65} minSize={30}>
                <TestCanvas />
              </ResizablePanel>

              <ResizableHandle />

              {/* Console */}
              <ResizablePanel defaultSize={35} minSize={20}>
                <ConsolePanel logs={consoleLogs} onClose={() => setShowConsole(false)} />
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            <TestCanvas />
          )}
        </ResizablePanel>
      </ResizablePanelGroup>

      <TestGroupDialog
        open={groupDialogOpen}
        onOpenChange={(open) => {
          setGroupDialogOpen(open);
          if (!open) setEditingGroup(null);
        }}
        onSubmit={(data) => {
          if (editingGroup) {
            updateTestGroup(editingGroup.id, data);
          } else {
            addTestGroup(data);
          }
        }}
        initialData={editingGroup || undefined}
        mode={editingGroup ? "edit" : "create"}
      />

      <TestCaseDialog
        open={testCaseDialogOpen}
        onOpenChange={(open) => {
          setTestCaseDialogOpen(open);
          if (!open) {
            setEditingTestCase(null);
            setSelectedGroupId("");
          }
        }}
        onSubmit={(data) => {
          if (editingTestCase) {
            updateTestCase(editingTestCase.id, data);
          } else {
            addTestCase(data);
          }
        }}
        groupId={selectedGroupId}
        nodeId={editingTestCase?.id}
        initialData={editingTestCase || undefined}
        mode={editingTestCase ? "edit" : "create"}
      />

      {validatorOpen && (
        <FlowValidator
          nodes={nodes}
          edges={edges}
          testGroups={testGroups}
          onClose={() => setValidatorOpen(false)}
        />
      )}
    </div>
  );
};

const ProjectDetail = () => {
  return (
    <TestProjectProvider>
      <ProjectDetailContent />
    </TestProjectProvider>
  );
};

export default ProjectDetail;
