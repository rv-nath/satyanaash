import { useState } from "react";
import { useParams, Link, useNavigate, useSearchParams } from "react-router-dom";
import { generateUUID } from "@/lib/utils/uuid";
import {
  ArrowLeft, Play, Settings, CheckCircle2, Download, Bug, Loader2, AlertCircle,
  Undo2, Redo2, Cloud, CloudOff, Save, ChevronDown, Spline, Minus, ArrowRightToLine,
  AlignStartHorizontal, AlignStartVertical, AlignEndVertical, AlignEndHorizontal,
  AlignVerticalJustifyCenter, AlignHorizontalJustifyCenter, Pencil
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
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
    exportFlowJSON,
    undo,
    redo,
    canUndo,
    canRedo,
    saveStatus,
    saveError,
    // Canvas settings
    showEdgeLabels,
    setShowEdgeLabels,
    snapToGrid,
    setSnapToGrid,
    edgeType,
    setEdgeType,
    alignNodes
  } = useTestProject();

  // Derive active flow for header
  const activeFlow = testGroups.find(g => g.id === activeFlowId);

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

  // Inline editing state for flow name and description
  const [editingFlowName, setEditingFlowName] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [tempName, setTempName] = useState("");
  const [tempDescription, setTempDescription] = useState("");

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

  // Auto-create a new flow with generated name
  const handleCreateFlow = async () => {
    if (!projectId) {
      toast.error("Project ID not found");
      return;
    }

    // Generate next flow number based on existing flows
    const existingNumbers = testGroups
      .map(g => {
        const match = g.name.match(/^Flow (\d+)$/);
        return match ? parseInt(match[1], 10) : 0;
      })
      .filter(n => n > 0);
    const nextNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
    const flowName = `Flow ${nextNumber}`;

    try {
      const newFlow = await createFlowMutation.mutateAsync({
        projectId,
        data: {
          name: flowName,
          description: "",
          graph_data: {
            nodes: [
              { id: generateUUID(), type: 'start', position: { x: 250, y: 50 }, data: { label: 'Start' } },
              { id: generateUUID(), type: 'end', position: { x: 250, y: 480 }, data: { label: 'End' } },
            ],
            edges: []
          }
        }
      });
      setActiveFlowId(newFlow.id);
      toast.success(`Created "${flowName}"`);
    } catch (err) {
      toast.error("Failed to create flow");
      console.error(err);
    }
  };

  // Inline editing handlers for flow name and description
  const startEditingName = () => {
    setTempName(activeFlow?.name || "");
    setEditingFlowName(true);
  };

  const startEditingDescription = () => {
    setTempDescription(activeFlow?.description || "");
    setEditingDescription(true);
  };

  const handleSaveName = async () => {
    if (!activeFlow || !tempName.trim()) {
      setEditingFlowName(false);
      return;
    }
    if (tempName !== activeFlow.name) {
      try {
        await updateFlowMutation.mutateAsync({
          id: activeFlow.id,
          data: { name: tempName, version: activeFlow.version },
          projectId: id || ''
        });
        updateTestGroup(activeFlow.id, { name: tempName });
      } catch (err) {
        toast.error("Failed to update flow name");
      }
    }
    setEditingFlowName(false);
  };

  const handleSaveDescription = async () => {
    if (!activeFlow) {
      setEditingDescription(false);
      return;
    }
    if (tempDescription !== (activeFlow.description || "")) {
      try {
        await updateFlowMutation.mutateAsync({
          id: activeFlow.id,
          data: { description: tempDescription, version: activeFlow.version },
          projectId: id || ''
        });
        updateTestGroup(activeFlow.id, { description: tempDescription });
      } catch (err) {
        toast.error("Failed to update description");
      }
    }
    setEditingDescription(false);
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border bg-card px-6 py-3 flex items-center justify-between">
        {/* Left: Back + Contextual Title */}
        <div className="flex items-center gap-4">
          <Link to="/">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="w-4 h-4" />
            </Button>
          </Link>
          <div className="flex items-center gap-3">
            <div className="flex flex-col">
              {/* Flow name row */}
              <div className="flex items-center">
                <span className="text-lg font-semibold font-mono text-foreground">
                  {project?.name || 'Project'}
                </span>
                {!isEditing && activeFlow && (
                  <>
                    <span className="text-muted-foreground font-normal"> / </span>
                    {editingFlowName ? (
                      <Input
                        value={tempName}
                        onChange={(e) => setTempName(e.target.value)}
                        onBlur={handleSaveName}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveName();
                          if (e.key === 'Escape') setEditingFlowName(false);
                        }}
                        className="h-7 w-48 text-lg font-semibold font-mono"
                        autoFocus
                      />
                    ) : (
                      <>
                        <span className="text-lg font-semibold font-mono text-muted-foreground">{activeFlow.name}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 ml-1"
                          onClick={startEditingName}
                          title="Edit flow name"
                        >
                          <Pencil className="w-3 h-3" />
                        </Button>
                      </>
                    )}
                  </>
                )}
                {isEditing && testId === 'new' && (
                  <span className="text-muted-foreground font-normal"> / New Test</span>
                )}
                {isEditing && testId !== 'new' && (
                  <span className="text-muted-foreground font-normal"> / Edit Test</span>
                )}
              </div>

              {/* Description row - only when flow active */}
              {!isEditing && activeFlow && (
                editingDescription ? (
                  <Input
                    value={tempDescription}
                    onChange={(e) => setTempDescription(e.target.value)}
                    onBlur={handleSaveDescription}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveDescription();
                      if (e.key === 'Escape') setEditingDescription(false);
                    }}
                    className="h-5 text-xs w-64 mt-0.5"
                    placeholder="Add description..."
                    autoFocus
                  />
                ) : (
                  <span
                    className="text-xs text-muted-foreground cursor-pointer hover:text-foreground mt-0.5"
                    onClick={startEditingDescription}
                  >
                    {activeFlow.description || "Add description..."}
                  </span>
                )
              )}
            </div>
            {/* Save status - only when on canvas with flow */}
            {!isEditing && activeFlow && (
              <div className="text-xs">
                {saveStatus === 'idle' && (
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Cloud className="w-3.5 h-3.5" />
                  </span>
                )}
                {saveStatus === 'saving' && (
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  </span>
                )}
                {saveStatus === 'pending' && (
                  <span className="flex items-center gap-1.5 text-warning">
                    <Save className="w-3.5 h-3.5" />
                  </span>
                )}
                {saveStatus === 'saved' && (
                  <span className="flex items-center gap-1.5 text-success">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                  </span>
                )}
                {saveStatus === 'error' && (
                  <span className="flex items-center gap-1.5 text-destructive" title={saveError || 'Save failed'}>
                    <CloudOff className="w-3.5 h-3.5" />
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right: Contextual Actions */}
        <div className="flex items-center gap-1">
          {/* Canvas actions - only when on canvas with flow */}
          {!isEditing && activeFlow && (
            <>
              {/* Run - prominent, first */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="default" size="sm" disabled={isExecuting} className="gap-1">
                    {isExecuting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                    Run
                    <ChevronDown className="w-3 h-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => handleExecute("run")}>
                    <Play className="w-4 h-4 mr-2" /> Run
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleExecute("debug")}>
                    <Bug className="w-4 h-4 mr-2" /> Debug
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <div className="h-5 w-px bg-border mx-2" />

              {/* Undo/Redo group */}
              <Button variant="ghost" size="icon" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">
                <Undo2 className="w-4 h-4" />
              </Button>
              <Button variant="ghost" size="icon" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)">
                <Redo2 className="w-4 h-4" />
              </Button>

              <div className="h-5 w-px bg-border mx-2" />

              {/* Validate/Export group */}
              <Button variant="ghost" size="icon" onClick={() => setValidatorOpen(true)} title="Validate">
                <CheckCircle2 className="w-4 h-4" />
              </Button>
              <Button variant="ghost" size="icon" onClick={handleExportFlow} title="Export JSON">
                <Download className="w-4 h-4" />
              </Button>

              <div className="h-5 w-px bg-border mx-2" />
            </>
          )}

          {/* Settings dropdown - merged canvas + project */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" title="Settings">
                <Settings className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {/* Canvas settings - only when flow active */}
              {!isEditing && activeFlow && (
                <>
                  <DropdownMenuLabel>Canvas</DropdownMenuLabel>
                  <DropdownMenuCheckboxItem checked={showEdgeLabels} onCheckedChange={setShowEdgeLabels}>
                    Show Edge Labels
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem checked={showConsole} onCheckedChange={setShowConsole}>
                    Show Console
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem checked={snapToGrid} onCheckedChange={setSnapToGrid}>
                    Snap to Grid (20px)
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Connector Style</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={edgeType} onValueChange={(value) => setEdgeType(value as any)}>
                    <DropdownMenuRadioItem value="default">
                      <Spline className="h-4 w-4 mr-2" /> Curved
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="straight">
                      <Minus className="h-4 w-4 mr-2" /> Straight
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="smoothstep">
                      <ArrowRightToLine className="h-4 w-4 mr-2" /> L-Shaped
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <AlignStartHorizontal className="h-4 w-4 mr-2" /> Align Nodes
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem onClick={() => alignNodes('left')}>
                        <AlignStartVertical className="h-4 w-4 mr-2" /> Align Left
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => alignNodes('right')}>
                        <AlignEndVertical className="h-4 w-4 mr-2" /> Align Right
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => alignNodes('top')}>
                        <AlignStartHorizontal className="h-4 w-4 mr-2" /> Align Top
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => alignNodes('bottom')}>
                        <AlignEndHorizontal className="h-4 w-4 mr-2" /> Align Bottom
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => alignNodes('center-h')}>
                        <AlignVerticalJustifyCenter className="h-4 w-4 mr-2" /> Center Horizontally
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => alignNodes('center-v')}>
                        <AlignHorizontalJustifyCenter className="h-4 w-4 mr-2" /> Center Vertically
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuLabel>Project</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => setSettingsOpen(true)}>
                <Settings className="w-4 h-4 mr-2" /> Project Settings...
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

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
                  onAddGroup={handleCreateFlow}
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
          if (!editingGroup) return;
          // Get version from testGroups for optimistic locking
          const flowToEdit = testGroups.find(g => g.id === editingGroup.id);
          if (!flowToEdit) return;
          // Update existing flow via API
          try {
            await updateFlowMutation.mutateAsync({
              id: editingGroup.id,
              data: { name: data.name, description: data.description, version: flowToEdit.version },
              projectId: projectId || ''
            });
            updateTestGroup(editingGroup.id, data);
            toast.success("Flow updated");
          } catch (err) {
            toast.error("Failed to update flow");
            console.error(err);
          }
        }}
        initialData={editingGroup || undefined}
        mode="edit"
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
