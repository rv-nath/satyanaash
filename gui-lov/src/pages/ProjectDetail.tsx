import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  ArrowLeft, Play, Pause, RotateCcw, Settings, CheckCircle2, Download, ChevronDown, Bug, Loader2, AlertCircle, Cloud, CloudOff, Save
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
import { useProject, useFlows, useCreateFlow, useUpdateFlow, useDeleteFlow, useExecuteFlow, useCreateTestCase, useUpdateTestCase, useDeleteTestCase } from "@/hooks/useApi";
import { Card } from "@/components/ui/card";

const ProjectDetailContent = () => {
  const { id } = useParams();
  const {
    project,
    projectId,
    testGroups,
    nodes,
    edges,
    activeFlowId,
    setActiveFlowId,
    showConsole,
    setShowConsole,
    toggleGroup,
    addTestGroup,
    updateTestGroup,
    deleteTestGroup,
    addTestCase,
    updateTestCase,
    deleteTestCase,
    exportFlowJSON,
    saveStatus,
    lastSaved,
    saveError
  } = useTestProject();

  // API mutations for flows
  const createFlowMutation = useCreateFlow();
  const updateFlowMutation = useUpdateFlow();
  const deleteFlowMutation = useDeleteFlow();
  const executeFlowMutation = useExecuteFlow();

  // API mutations for test cases
  const createTestCaseMutation = useCreateTestCase();
  const updateTestCaseMutation = useUpdateTestCase();
  const deleteTestCaseMutation = useDeleteTestCase();
  
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

  const handleExecute = async (mode: "run" | "debug" = "run") => {
    if (!activeFlowId) {
      toast.error("No flow selected to execute");
      return;
    }

    setIsExecuting(true);
    setConsoleLogs(prev => [...prev, {
      timestamp: new Date().toISOString(),
      message: `Starting ${mode === "debug" ? "debug" : "test"} execution...`,
      type: "info" as const
    }]);

    try {
      const response = await executeFlowMutation.mutateAsync({
        id: activeFlowId,
        data: { debug_mode: mode === "debug" }
      });

      // Log execution results
      setConsoleLogs(prev => [...prev, {
        timestamp: new Date().toISOString(),
        message: `Execution completed in ${response.duration_ms}ms`,
        type: "info"
      }]);

      if (response.stats) {
        const { passed, failed, errors, total } = response.stats;
        const resultType = failed === 0 && errors === 0 ? "success" : "error";
        setConsoleLogs(prev => [...prev, {
          timestamp: new Date().toISOString(),
          message: `Results: ${passed}/${total} passed, ${failed} failed, ${errors} errors`,
          type: resultType
        }]);
      }

      if (response.status === 'completed') {
        toast.success("Test execution complete");
      } else {
        toast.error(`Execution finished with status: ${response.status}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Execution failed";
      setConsoleLogs(prev => [...prev, {
        timestamp: new Date().toISOString(),
        message: `Error: ${errorMsg}`,
        type: "error"
      }]);
      toast.error("Test execution failed");
    } finally {
      setIsExecuting(false);
    }
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
            <h1 className="text-lg font-semibold font-mono text-foreground">
              {project?.name || 'Project'}
            </h1>
            <p className="text-xs text-muted-foreground">
              {testGroups.length} flow{testGroups.length !== 1 ? 's' : ''}
            </p>
          </div>
          {/* Save Status Indicator */}
          <div className="flex items-center gap-2 text-xs ml-4 px-2 py-1 rounded bg-muted/50">
            {saveStatus === 'idle' && (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Cloud className="w-3 h-3" />
                All changes saved
              </span>
            )}
            {saveStatus === 'saving' && (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="w-3 h-3 animate-spin" />
                Saving...
              </span>
            )}
            {saveStatus === 'pending' && (
              <span className="flex items-center gap-1.5 text-warning">
                <Save className="w-3 h-3" />
                Unsaved changes
              </span>
            )}
            {saveStatus === 'saved' && (
              <span className="flex items-center gap-1.5 text-success">
                <CheckCircle2 className="w-3 h-3" />
                Saved
              </span>
            )}
            {saveStatus === 'error' && (
              <span className="flex items-center gap-1.5 text-destructive" title={saveError || 'Save failed'}>
                <CloudOff className="w-3 h-3" />
                Save failed
              </span>
            )}
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
                  onDeleteTestCase={async (testCaseId) => {
                    if (!projectId) return;
                    try {
                      await deleteTestCaseMutation.mutateAsync({ id: testCaseId, projectId });
                      deleteTestCase(testCaseId);
                      toast.success("Test case deleted");
                    } catch (err) {
                      toast.error("Failed to delete test case");
                      console.error(err);
                    }
                  }}
                />
              </TabsContent>
              
              <TabsContent value="flows" className="flex-1 mt-0">
                <FlowsList
                  onAddGroup={() => setGroupDialogOpen(true)}
                  onEditGroup={(group) => {
                    setEditingGroup({ id: group.id, name: group.name, description: group.description });
                    setGroupDialogOpen(true);
                  }}
                  onDeleteGroup={async (flowId) => {
                    if (!projectId) return;
                    try {
                      await deleteFlowMutation.mutateAsync({ id: flowId, projectId });
                      deleteTestGroup(flowId);
                      toast.success("Flow deleted");
                    } catch (err) {
                      toast.error("Failed to delete flow");
                      console.error(err);
                    }
                  }}
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
        onSubmit={async (data) => {
          if (editingGroup) {
            // Update existing flow via API
            try {
              await updateFlowMutation.mutateAsync({
                id: editingGroup.id,
                data: { name: data.name, description: data.description },
                projectId: projectId || ''
              });
              updateTestGroup(editingGroup.id, data);
              toast.success("Flow updated successfully");
            } catch (err) {
              toast.error("Failed to update flow");
              console.error(err);
            }
          } else {
            // Create new flow via API
            if (!projectId) {
              toast.error("Project ID not found");
              return;
            }
            try {
              const newFlow = await createFlowMutation.mutateAsync({
                projectId,
                data: {
                  name: data.name,
                  description: data.description,
                  graph_data: {
                    nodes: [
                      { id: `start-new`, type: 'start', position: { x: 250, y: 50 }, data: { label: 'Start' } },
                      { id: `end-new`, type: 'end', position: { x: 250, y: 480 }, data: { label: 'End' } },
                    ],
                    edges: []
                  }
                }
              });
              // Set the new flow as active
              setActiveFlowId(newFlow.id);
              toast.success("Flow created successfully");
            } catch (err) {
              toast.error("Failed to create flow");
              console.error(err);
            }
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
        onSubmit={async (data) => {
          if (!projectId) {
            toast.error("Project ID not found");
            return;
          }

          // Map frontend data to API format
          // Note: payload stays as string (backend expects String), headers gets parsed (backend expects JSON Value)
          const apiData = {
            name: data.name,
            method: data.method,
            endpoint: data.endpoint || '',
            headers: data.headers ? JSON.parse(data.headers) : undefined,
            payload: data.payload || undefined,  // Keep as string - backend expects Option<String>
            assertion_script: data.postTestScript || undefined,
          };

          if (editingTestCase) {
            // Update existing test case via API
            try {
              await updateTestCaseMutation.mutateAsync({
                id: editingTestCase.id,
                data: apiData,
                projectId
              });
              updateTestCase(editingTestCase.id, data);
              toast.success("Test case updated");
            } catch (err) {
              toast.error("Failed to update test case");
              console.error(err);
            }
          } else {
            // Create new test case via API
            try {
              await createTestCaseMutation.mutateAsync({
                projectId,
                data: apiData
              });
              addTestCase(data);
              toast.success("Test case created");
            } catch (err) {
              toast.error("Failed to create test case");
              console.error(err);
            }
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
  const { id } = useParams();
  const { data: project, isLoading: projectLoading, error: projectError } = useProject(id || '');
  const { data: flows, isLoading: flowsLoading } = useFlows(id || '');

  // Loading state
  if (projectLoading || flowsLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Loading project...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (projectError) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <Card className="p-8 text-center border-destructive max-w-md">
          <AlertCircle className="w-12 h-12 mx-auto mb-4 text-destructive" />
          <h3 className="text-lg font-medium text-foreground mb-2">Failed to load project</h3>
          <p className="text-muted-foreground mb-4">
            {projectError instanceof Error ? projectError.message : "Project not found"}
          </p>
          <Link to="/">
            <Button>
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Projects
            </Button>
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <TestProjectProvider projectId={id} project={project} initialFlows={flows}>
      <ProjectDetailContent />
    </TestProjectProvider>
  );
};

export default ProjectDetail;
