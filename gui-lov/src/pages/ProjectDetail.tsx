import { useState } from "react";
import { useParams, Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft, Play, Pause, RotateCcw, Settings, CheckCircle2, Download, ChevronDown, Bug, Loader2, AlertCircle
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
import { TestInventory } from "@/components/TestInventory";
import { FlowsList } from "@/components/FlowsList";
import { FlowValidator } from "@/components/FlowValidator";
import { TestCaseEditor } from "@/components/TestCaseEditor";
import { useProject, useFlows, useCreateFlow, useUpdateFlow, useDeleteFlow, useDeleteTestCase, useUpdateProject } from "@/hooks/useApi";
import { ProjectSettingsDialog } from "@/components/ProjectSettingsDialog";
import { useExecutionStream } from "@/hooks/useExecutionStream";
import { Card } from "@/components/ui/card";

const ProjectDetailContent = () => {
  const { id, testId } = useParams();  // testId comes from /project/:id/test/:testId route
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const {
    project,
    projectId,
    testGroups,
    nodes,
    edges,
    activeFlowId,
    setActiveFlowId,
    sidebarTab,
    setSidebarTab,
    showConsole,
    setShowConsole,
    updateTestGroup,
    deleteTestGroup,
    deleteTestCase,
    exportFlowJSON
  } = useTestProject();

  // Determine if we're in edit mode from URL (testId from route)
  const isEditing = !!testId;
  const editingTestCaseId = testId === 'new' ? '__new__' : testId;

  // Navigation-based editor open/close
  const openTestCaseEditor = (testCaseId?: string) => {
    const path = testCaseId
      ? `/project/${id}/test/${testCaseId}`
      : `/project/${id}/test/new`;
    // Only keep tab param when editing (test cases are project-level, not flow-specific)
    const tabParam = searchParams.get('tab');
    const queryString = tabParam ? `?tab=${tabParam}` : '';
    navigate(`${path}${queryString}`);
  };

  const closeTestCaseEditor = () => {
    // Restore flow param when returning to canvas
    const tabParam = searchParams.get('tab');
    const params = new URLSearchParams();
    if (activeFlowId) params.set('flow', activeFlowId);
    if (tabParam) params.set('tab', tabParam);
    navigate(`/project/${id}?${params.toString()}`);
  };

  // API mutations for flows
  const createFlowMutation = useCreateFlow();
  const updateFlowMutation = useUpdateFlow();
  const deleteFlowMutation = useDeleteFlow();

  // API mutations for test cases
  const deleteTestCaseMutation = useDeleteTestCase();

  // SSE streaming for real-time execution logs
  const { logs: consoleLogs, isExecuting, execute: executeFlow, clearLogs } = useExecutionStream();

  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [validatorOpen, setValidatorOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<{ id: string; name: string; description?: string } | null>(null);

  // API mutation for project settings
  const updateProjectMutation = useUpdateProject();

  const handleExecute = async (mode: "run" | "debug" = "run") => {
    if (!activeFlowId) {
      toast.error("No flow selected to execute");
      return;
    }

    // Show console panel when executing
    setShowConsole(true);

    // Execute using SSE streaming - logs are handled by the hook
    await executeFlow(activeFlowId, { debug_mode: mode === "debug" });
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
          <Button variant="outline" size="icon" onClick={() => setSettingsOpen(true)}>
            <Settings className="w-4 h-4" />
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <ResizablePanelGroup direction="horizontal" className="flex-1">
        {/* Left Panel with Tabs */}
        <ResizablePanel defaultSize={35} minSize={25} maxSize={45}>
          <div className="h-full bg-sidebar border-r border-sidebar-border">
            <Tabs value={sidebarTab} onValueChange={(v) => setSidebarTab(v as 'tests' | 'flows')} className="h-full flex flex-col">
              <div className="border-b border-sidebar-border px-4 pt-4">
                <TabsList className="w-full">
                  <TabsTrigger value="tests" className="flex-1">Tests</TabsTrigger>
                  <TabsTrigger value="flows" className="flex-1">Flows</TabsTrigger>
                </TabsList>
              </div>
              
              <TabsContent value="tests" className="flex-1 mt-0">
                <TestInventory
                  onAddTestCase={() => {
                    // Open editor in create mode
                    openTestCaseEditor();
                  }}
                  onEditTestCase={(test) => {
                    // Open editor in edit mode
                    openTestCaseEditor(test.id);
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
                />
              </TabsContent>
            </Tabs>
          </div>
        </ResizablePanel>

        <ResizableHandle />

        {/* Canvas & Console / Test Case Editor */}
        <ResizablePanel defaultSize={80}>
          {isEditing ? (
            // Full-screen test case editor (create or edit mode)
            <TestCaseEditor
              testCaseId={testId === 'new' ? undefined : testId}
              onClose={closeTestCaseEditor}
              onCreated={(newId) => {
                // After creation, switch to edit mode with the new ID
                openTestCaseEditor(newId);
              }}
            />
          ) : showConsole ? (
            <ResizablePanelGroup direction="vertical">
              {/* Canvas */}
              <ResizablePanel defaultSize={65} minSize={30}>
                <TestCanvas />
              </ResizablePanel>

              <ResizableHandle />

              {/* Console */}
              <ResizablePanel defaultSize={35} minSize={20}>
                <ConsolePanel logs={consoleLogs} onClose={() => setShowConsole(false)} onClear={clearLogs} />
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

      {validatorOpen && (
        <FlowValidator
          nodes={nodes}
          edges={edges}
          testGroups={testGroups}
          activeFlowId={activeFlowId}
          onClose={() => setValidatorOpen(false)}
        />
      )}

      {project && (
        <ProjectSettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          project={project}
          onSave={async (settings) => {
            if (!projectId) return;
            await updateProjectMutation.mutateAsync({
              id: projectId,
              data: { settings },
            });
          }}
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
