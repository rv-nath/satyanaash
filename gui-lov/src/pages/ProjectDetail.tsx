import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { generateUUID } from "@/lib/utils/uuid";
import {
  ArrowLeft, Play, Settings, CheckCircle2, Download, Footprints, Loader2, AlertCircle,
  Undo2, Redo2, Cloud, CloudOff, Save, ChevronDown, Spline, Minus, ArrowRightToLine,
  AlignStartHorizontal, AlignStartVertical, AlignEndVertical, AlignEndHorizontal,
  AlignVerticalJustifyCenter, AlignHorizontalJustifyCenter, Pencil, Network, MoveVertical, MoveHorizontal,
  AlignHorizontalSpaceAround, AlignVerticalSpaceAround,
  // Aliased: the bare name resolves to the DOM's History interface, and TypeScript picks
  // that over the icon without complaining until you use it as a component.
  History as HistoryIcon
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { WorkspaceWelcome } from "@/components/WorkspaceWelcome";
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
import { toast } from "sonner";
import TestCanvas from "@/components/TestCanvas";
import ConsolePanel from "@/components/ConsolePanel";
import { TestProjectProvider, useTestProject } from "@/contexts/TestProjectContext";
import { TestGroupDialog } from "@/components/TestGroupDialog";
import { TestInventory } from "@/components/TestInventory";
import { FlowsList } from "@/components/FlowsList";
import { FlowValidator } from "@/components/FlowValidator";
import { ValidationBadge } from "@/components/ValidationBadge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { TestCaseEditor } from "@/components/TestCaseEditor";
import type { TestCaseExecutionResult } from "@/lib/api/types";
import type { LayoutSpacing } from "@/lib/layoutUtils";
import { useProject, useFlows, useCreateFlow, useCloneFlow, useUpdateFlow, useDeleteFlow, useDeleteTestCase, useUpdateTestCase, useTestCases } from "@/hooks/useApi";
import { WorkspaceTabs, type RenderTab } from "@/components/WorkspaceTabs";
import { SettingsPanel } from "@/components/SettingsPanel";
import RunHistory from "@/components/RunHistory";
import RunView from "@/components/RunView";
import SuiteEditor from "@/components/SuiteEditor";
import { SuitesList } from "@/components/SuitesList";
import { ActivityRail } from "@/components/ActivityRail";
import { RunsRail } from "@/components/RunsRail";
import { useRailView } from "@/hooks/useRailView";
import type { RailView } from "@/lib/railViews";
import { useQuery } from "@tanstack/react-query";
import { suitesApi } from "@/lib/api";
import { consoleTabsFor, shownConsole } from "@/lib/consoleTabs";
import { suiteLogKey } from "@/lib/runHistory";
import { tabKey, atCap, MAX_TABS, activeSurface } from "@/lib/workspaceTabs";
import { ApiClientError } from "@/lib/api/client";
import { FlowVariablesDialog } from "@/components/FlowVariablesDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Card } from "@/components/ui/card";

const ProjectDetailContent = () => {
  const { id, testId } = useParams();  // testId comes from /project/:id/test/:testId route
  const navigate = useNavigate();
  const {
    project,
    projectId,
    testGroups,
    nodes,
    edges,
    activeFlowId,
    setActiveFlowId,
    workspace,
    openTestTab,
    openFlowTab,
    openSettingsTab,
    openRunsTab,
    openSuiteTab,
    openRunTab,
    toggleRunPinned,
    liveRun,
    closeWorkspaceTab,
    setActiveWorkspaceTab,
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
    manualSave,
    saveError,
    // Validation status
    validationStatus,
    validationErrors,
    validationWarnings,
    // Canvas settings
    showEdgeLabels,
    setShowEdgeLabels,
    snapToGrid,
    setSnapToGrid,
    edgeType,
    setEdgeType,
    alignNodes,
    flowVariables,
    setFlowVariables,
    environments,
    activeEnvId,
    activeEnv,
    selectEnv,
    effectiveEnvironment,
    requestAutoLayout,
    logsByFlow,
    executingFlowId,
    isExecuting,
    executeFlow,
    clearLogs,
    closeLogs,
  } = useTestProject();

  // Arrange density — remembered for the session and used by both the toolbar
  // button and the menu items.
  const [layoutSpacing, setLayoutSpacing] = useState<LayoutSpacing>('comfortable');

  // Derive active flow for header
  const activeFlow = testGroups.find(g => g.id === activeFlowId);

  // Test cases (for workspace tab labels)
  const { data: apiTestCases } = useTestCases(projectId || '');
  // Only for the tab label; the editor owns the suite itself. Same cache key as the rail
  // and the editor, so a rename lands on all three at once.
  const { data: apiSuites } = useQuery({
    queryKey: ['suites', projectId],
    queryFn: () => suitesApi.list(projectId!),
    enabled: !!projectId,
  });

  // Flows edited this session — a flow tab stops being reused once edited
  // (VS Code preview-tab semantics).
  const [modifiedFlowIds, setModifiedFlowIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (activeFlowId && (saveStatus === 'pending' || saveStatus === 'saving')) {
      setModifiedFlowIds((prev) => (prev.has(activeFlowId) ? prev : new Set(prev).add(activeFlowId)));
    }
  }, [saveStatus, activeFlowId]);

  // What the workspace is showing — one answer, parsed once. Everything below reads this
  // rather than re-deriving from `workspace.active`, so there is nowhere for two views to
  // decide they are both on screen.
  const surface = activeSurface(workspace);
  const activeIsFlow = surface.kind === 'flow';
  const activeIsTest = surface.kind === 'test';
  const activeIsSettings = surface.kind === 'settings';
  const activeTestId = surface.kind === 'test' ? surface.id : null;
  const activeSuiteId = surface.kind === 'suite' ? surface.id : null;

  // Tab-bar render models
  // Per-tab editor state kept outside the editors, so it survives close/reopen:
  // the active sub-tab and the last run's result.
  const editorSubTabRef = useRef<Record<string, string>>({});
  const persistEditorSubTab = useCallback((key: string, tab: string) => {
    editorSubTabRef.current[key] = tab;
  }, []);
  const editorResultRef = useRef<Record<string, unknown>>({});
  const persistEditorResult = useCallback((key: string, result: unknown) => {
    if (result == null) delete editorResultRef.current[key];
    else editorResultRef.current[key] = result;
  }, []);

  // Unsaved-changes tracking per test tab — drives the tab dot and the close guard.
  const [dirtyTabs, setDirtyTabs] = useState<Record<string, boolean>>({});
  const markTabDirty = useCallback((key: string, dirty: boolean) => {
    setDirtyTabs((prev) => (prev[key] === dirty ? prev : { ...prev, [key]: dirty }));
  }, []);

  // Forget a closed tab's remembered state.
  const forgetTab = useCallback((key: string) => {
    delete editorSubTabRef.current[key];
    delete editorResultRef.current[key];
    setDirtyTabs((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  // Closing a tab with unsaved edits asks first.
  const [pendingCloseKey, setPendingCloseKey] = useState<string | null>(null);
  const doCloseTab = useCallback((key: string) => {
    closeWorkspaceTab(key);
    forgetTab(key);
  }, [closeWorkspaceTab, forgetTab]);
  const requestCloseTab = useCallback((key: string) => {
    if (dirtyTabs[key]) setPendingCloseKey(key);
    else doCloseTab(key);
  }, [dirtyTabs, doCloseTab]);

  const renderTabs: RenderTab[] = workspace.tabs.map((t) => {
    if (t.kind === 'flow') {
      const flow = testGroups.find((g) => g.id === t.id);
      return { key: tabKey('flow', t.id), kind: 'flow', label: flow?.name || 'Flow' };
    }
    if (t.kind === 'run') {
      // A run is a record, so its label is what it was and when — not a name anyone
      // chose, and not renameable.
      const live = liveRun?.runId === t.id ? liveRun : null;
      const label = live
        ? `${live.suiteName} · ${new Date(live.startedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
        : 'Run';
      return { key: tabKey('run', t.id), kind: 'run', label, renameable: false, pinned: t.pinned };
    }
    if (t.kind === 'suite') {
      // Renamed in the editor, where the field sits beside the Run button — so the tab is
      // a label, not a second place to edit the same name.
      const suite = (apiSuites || []).find((s) => s.id === t.id);
      return { key: tabKey('suite', t.id), kind: 'suite', label: suite?.name || 'Suite', renameable: false };
    }
    const key = tabKey('test', t.id);
    // An unsaved New Test has no record to rename; its name belongs to the editor.
    if (t.id === '__new__') {
      return { key, kind: 'test', label: 'New Test', method: 'NEW', dirty: dirtyTabs[key], renameable: false };
    }
    const tc = (apiTestCases || []).find((x) => x.id === t.id);
    return { key, kind: 'test', label: tc?.name || 'Test', method: (tc?.method as string) || '', dirty: dirtyTabs[key] };
  });

  // Activate a tab; keep activeFlowId in sync for flow tabs.
  const activateTab = (key: string) => {
    setActiveWorkspaceTab(key);
    if (key.startsWith('flow:')) setActiveFlowId(key.slice('flow:'.length));
  };

  // Open a test case as a workspace tab (undefined = create mode). The tab cap and its
  // complaint live in openTestTab, so every route to a test behaves the same.
  const openTestCaseEditor = (testCaseId?: string) => openTestTab(testCaseId ?? '__new__');

  // Open a flow as a (reuse-if-unedited) workspace tab
  const handleOpenFlow = (flowId: string) => {
    const alreadyOpen = workspace.tabs.some((t) => t.kind === 'flow' && t.id === flowId);
    const activeFlowKey = activeIsFlow ? workspace.active!.slice('flow:'.length) : null;
    const canReuse = !!activeFlowKey && !modifiedFlowIds.has(activeFlowKey);
    if (!alreadyOpen && !canReuse && atCap(workspace)) {
      toast.warning(`Too many tabs open (max ${MAX_TABS}). Close one first.`);
      return;
    }
    setActiveFlowId(flowId);
    openFlowTab(flowId, canReuse);
  };

  // Deep-link support: /project/:id/test/:testId opens that test as a tab
  useEffect(() => {
    if (testId) {
      openTestTab(testId === 'new' ? '__new__' : testId);
      // Drop the /test/:testId segment; tab state is client-side, not URL-addressed
      navigate(`/project/${id}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testId]);

  // API mutations for flows
  const createFlowMutation = useCreateFlow();
  const cloneFlowMutation = useCloneFlow();
  const updateFlowMutation = useUpdateFlow();
  const deleteFlowMutation = useDeleteFlow();

  // API mutations for test cases
  const deleteTestCaseMutation = useDeleteTestCase();
  const updateTestCaseMutation = useUpdateTestCase();

  /**
   * Rename whatever a tab points at, from a double-click on its label.
   *
   * Refused while the tab has unsaved edits: the write would land on the server and
   * the refetch behind it could pull the record out from under an editor still holding
   * other changes. Saving first costs one click and can't lose anything.
   */
  const handleRenameTab = async (key: string, name: string) => {
    const tab = renderTabs.find((t) => t.key === key);
    if (!tab) return;
    if (dirtyTabs[key]) {
      toast.error('Save this tab before renaming it');
      return;
    }
    try {
      if (tab.kind === 'flow') {
        const flowId = key.slice('flow:'.length);
        const flow = testGroups.find((g) => g.id === flowId);
        await updateFlowMutation.mutateAsync({
          id: flowId,
          data: { name, version: flow?.version ?? 1 },
          projectId: id || '',
        });
        // The rail and the tabs read the local copy, so it has to hear about it too.
        updateTestGroup(flowId, { name });
      } else {
        await updateTestCaseMutation.mutateAsync({
          id: key.slice('test:'.length),
          data: { name },
          projectId: id || '',
        });
      }
    } catch (err) {
      // A background flow tab can hold a stale version — someone saved that flow
      // somewhere else since. Say that, rather than quoting the numbers at them.
      if (err instanceof ApiClientError && err.code === 'VERSION_CONFLICT') {
        toast.error(`"${tab.label}" changed elsewhere. Open its tab and try again.`);
      } else {
        const reason = err instanceof Error ? err.message : '';
        toast.error(reason ? `Couldn't rename "${tab.label}": ${reason}` : `Couldn't rename "${tab.label}"`);
      }
    }
  };

  // Which flow's console is on screen. It follows the canvas, but you can pin
  // another flow's log to compare two runs.
  const [consoleFlowId, setConsoleFlowId] = useState<string | null>(null);
  useEffect(() => {
    if (activeFlowId) setConsoleFlowId(activeFlowId);
  }, [activeFlowId]);
  // Opening a suite points the console at its own log, so pressing Run shows that run's
  // output rather than whichever flow happened to be pinned.
  useEffect(() => {
    if (activeSuiteId) setConsoleFlowId(suiteLogKey(activeSuiteId));
  }, [activeSuiteId]);

  // A tab per producer that has output — flows and suites both — plus whatever is on
  // screen so the panel is never headless.
  const consoleTabs = useMemo(
    () =>
      consoleTabsFor({
        logKeys: Object.keys(logsByFlow),
        flows: testGroups,
        suites: apiSuites ?? [],
        activeFlowId,
        activeSuiteKey: activeSuiteId ? suiteLogKey(activeSuiteId) : null,
        executingId: executingFlowId,
        entryCount: (key) => logsByFlow[key]?.length ?? 0,
      }),
    [logsByFlow, activeFlowId, activeSuiteId, testGroups, apiSuites, executingFlowId],
  );

  const shownConsoleId = shownConsole(consoleTabs, consoleFlowId);

  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [validatorOpen, setValidatorOpen] = useState(false);
  const [flowVarsOpen, setFlowVarsOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<{ id: string; name: string; description?: string } | null>(null);

  // Inline editing state for flow name and description
  const [editingFlowName, setEditingFlowName] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [tempName, setTempName] = useState("");
  const [tempDescription, setTempDescription] = useState("");

  // Environments & globals now live in the context (shared with the editor,
  // which sends the effective env and persists SAT.env writes).

  // Which list the sidebar is showing. Remembered between sessions: the view you want is
  // a property of how you work, not of the project.
  const { view: railView, setView: setRailView } = useRailView();

  // Settings tab landing section. Open with an optional view so, e.g., the
  // Environments card / "Manage environments" land on the environments area.
  const [settingsInitialView, setSettingsInitialView] = useState<string | undefined>(undefined);
  const envLandingView = useMemo(
    () => (environments[0] ? `env:${environments[0].id}` : "environments"),
    [environments]
  );
  const openSettings = (view?: string) => {
    setSettingsInitialView(view);
    openSettingsTab();
  };

  const handleExecute = async (mode: "run" | "step" = "run") => {
    if (!activeFlowId) {
      toast.error("No flow selected to execute");
      return;
    }

    // The server runs the flow from its own copy of the graph, so an edit still
    // sitting in the auto-save debounce would be invisible to the run — you'd be
    // reading results from a version you can no longer see. Flush first.
    if (saveStatus === "pending" || saveStatus === "saving" || saveStatus === "error") {
      if (!(await manualSave())) {
        toast.error("Couldn't save the flow, so a run would use an older version of it.");
        return;
      }
    }

    // Show console panel when executing
    setShowConsole(true);

    // Globals overlaid with the active environment (env wins).
    const env = effectiveEnvironment();

    // Execute using SSE streaming - logs are handled by the hook.
    // debug_mode is always on: it only adds variable provenance and the per-node
    // request log, both of which sit behind the console's collapsible details. A run
    // whose variables resolved from somewhere unexpected is the hard failure to
    // diagnose, and there is no reason to have to ask for the evidence twice.
    await executeFlow(activeFlowId, {
      debug_mode: true,
      environment: env,
      step: mode === "step",
    });
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
  const handleCloneFlow = async (flowId: string) => {
    if (!projectId) return;

    // The server copies its own stored graph, so an edit still waiting on the
    // auto-save debounce would be missing from the duplicate — and you'd only
    // find out later, looking at a copy of something you never saw.
    if (
      flowId === activeFlowId &&
      (saveStatus === "pending" || saveStatus === "saving" || saveStatus === "error")
    ) {
      if (!(await manualSave())) {
        toast.error("Couldn't save this flow, so a copy would miss your latest change.");
        return;
      }
    }

    try {
      const copy = await cloneFlowMutation.mutateAsync({ id: flowId, projectId });
      setActiveFlowId(copy.id);
      openFlowTab(copy.id, false);
      toast.success(`Created "${copy.name}"`);
    } catch (err) {
      toast.error("Failed to duplicate flow");
      console.error(err);
    }
  };

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
      openFlowTab(newFlow.id, false);
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

  /** A surface with the console under it, when the console is showing. */
  const withConsole = (main: React.ReactNode, fallbackConsoleId: string | null) =>
    showConsole ? (
      <ResizablePanelGroup direction="vertical">
        <ResizablePanel defaultSize={65} minSize={30}>
          {main}
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize={35} minSize={20}>
          <ConsolePanel
            logs={(shownConsoleId && logsByFlow[shownConsoleId]) || []}
            tabs={consoleTabs}
            activeTabId={shownConsoleId}
            onSelectTab={setConsoleFlowId}
            onCloseTab={(id) => {
              closeLogs(id);
              // Closing the console you were reading falls back to whatever this surface
              // implies — the flow on screen, or nothing.
              if (id === consoleFlowId) setConsoleFlowId(fallbackConsoleId);
            }}
            onClose={() => setShowConsole(false)}
            onClear={() => shownConsoleId && clearLogs(shownConsoleId)}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    ) : (
      main
    );

  /**
   * The one view the workspace is showing.
   *
   * A switch rather than a pile of absolutely-positioned `&&` blocks: those stacked
   * instead of excluding each other, and the "nothing matched" case had to be spelled
   * out as a list of negations that grew by hand with every new kind. The first time it
   * was missed, the welcome screen painted over a run tab.
   *
   * `Surface` is a discriminated union, so TypeScript will not let a new kind be added
   * without a branch here.
   */
  function renderSurface(): React.ReactNode {
    switch (surface.kind) {
      case 'test':
      case 'settings':
        // Already on screen. Both keep their DOM while hidden so an unsaved draft
        // survives a trip to another tab, which a switch that mounts one branch cannot
        // do — so they are painted above and this branch deliberately adds nothing.
        return null;

      case 'flow':
        return withConsole(<TestCanvas />, activeFlowId ?? null);

      case 'suite':
        return projectId
          ? withConsole(<SuiteEditor suiteId={surface.id} projectId={projectId} />, null)
          : null;

      case 'run':
        return <RunView runId={surface.id} liveRun={liveRun} />;

      case 'runs':
        // Refetches on open rather than staying mounted: there is nothing unsaved to
        // lose, and a history that reloads is a history that is up to date.
        return projectId ? <RunHistory projectId={projectId} onOpenRun={openRunTab} /> : null;

      case 'empty':
        return (
          <WorkspaceWelcome
            onNewTest={() => openTestCaseEditor()}
            onNewFlow={handleCreateFlow}
            onOpenEnvironments={() => openSettings(envLandingView)}
          />
        );

      default: {
        // Not decoration. Without it a missing case just falls through and returns
        // undefined — which `ReactNode` happily accepts — so the compiler would say
        // nothing and the pane would be blank. Assigning to `never` is what actually
        // makes adding a kind without a branch a build error.
        const unhandled: never = surface;
        return unhandled;
      }
    }
  }

  // The sidebar's lists, built once. Both the stacked Workspace view and the dedicated
  // full-height views render the same element, so a handler cannot drift between them.
  const testsList = (
    <TestInventory
      onAddTestCase={() => openTestCaseEditor()}
      onEditTestCase={(test) => openTestCaseEditor(test.id)}
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
  );

  const flowsList = (
    <FlowsList
      onOpenFlow={handleOpenFlow}
      onAddGroup={handleCreateFlow}
      onEditGroup={(group) => {
        setEditingGroup({ id: group.id, name: group.name, description: group.description });
        setGroupDialogOpen(true);
      }}
      onCloneGroup={handleCloneFlow}
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
  );

  const suitesList = projectId ? (
    <SuitesList projectId={projectId} onOpenSuite={openSuiteTab} />
  ) : null;

  const runsList = projectId ? (
    <RunsRail projectId={projectId} onOpenRun={openRunTab} onOpenFullHistory={openRunsTab} />
  ) : null;

  /**
   * What the sidebar shows, chosen by the rail.
   *
   * Workspace keeps the vertical `ResizablePanelGroup`; every other view replaces it
   * outright. Conditionally rendering one panel *inside* the group would be the bug:
   * react-resizable-panels registers panels by walking its direct children, so dropping the
   * middle one silently reorders the handles — the same fault as the Fragment-wrapped panel
   * that inverted a drag handle in the run tab. Swapping the whole group avoids it.
   */
  function renderSidebar(view: RailView): React.ReactNode {
    switch (view) {
      case "tests":
        return testsList;
      case "flows":
        return flowsList;
      case "suites":
        return suitesList;
      case "runs":
        return runsList;
      case "workspace":
        return (
          <ResizablePanelGroup direction="vertical">
            <ResizablePanel defaultSize={60} minSize={20}>
              {testsList}
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel defaultSize={30} minSize={15}>
              {flowsList}
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel defaultSize={20} minSize={10}>
              {suitesList}
            </ResizablePanel>
          </ResizablePanelGroup>
        );
      default: {
        // Same guard as `renderSurface`: without it a view added later falls through and
        // returns undefined, which ReactNode accepts, and the sidebar goes blank with no
        // compiler complaint.
        const unhandled: never = view;
        return unhandled;
      }
    }
  }

  // Computed once so the wrapper below can ask whether there is anything to wrap. Calling
  // it inline would render an empty overlay over the kept-mounted editors.
  const surfaceContent = renderSurface();

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border bg-card px-6 py-3 flex items-center justify-between">
        {/* Left: Back + Contextual Title */}
        <div className="flex min-w-0 items-center gap-4">
          <Link to="/">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="w-4 h-4" />
            </Button>
          </Link>
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex min-w-0 flex-col">
              {/* Flow name row */}
              <div className="flex min-w-0 items-center">
                <span className="truncate font-mono text-lg font-semibold text-foreground">
                  {project?.name || 'Project'}
                </span>
                {activeIsFlow && activeFlow && (
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
                {activeIsTest && activeTestId === '__new__' && (
                  <span className="text-muted-foreground font-normal"> / New Test</span>
                )}
                {activeIsTest && activeTestId !== '__new__' && (
                  <span className="text-muted-foreground font-normal"> / Edit Test</span>
                )}
              </div>

              {/* Description row - only when flow active */}
              {activeIsFlow && activeFlow && (
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
            {activeIsFlow && activeFlow && (
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
        {/* shrink-0: the header doesn't wrap, so without this a long project or
            flow name squeezes the toolbar and clips buttons off the right edge. */}
        <div className="flex shrink-0 items-center gap-1">
          {/* Environment switcher — always visible so the active env is clear */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5 font-normal">
                <span className="text-muted-foreground">Env:</span>
                <span className={activeEnv ? "text-primary font-medium" : ""}>{activeEnv ? activeEnv.name : "None"}</span>
                <ChevronDown className="w-3 h-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => selectEnv(null)}>
                {!activeEnvId && <CheckCircle2 className="w-3.5 h-3.5 mr-2 text-primary" />}
                <span className={!activeEnvId ? "" : "ml-[22px]"}>No environment</span>
              </DropdownMenuItem>
              {environments.length > 0 && <DropdownMenuSeparator />}
              {environments.map((env) => (
                <DropdownMenuItem key={env.id} onClick={() => selectEnv(env.id)}>
                  {activeEnvId === env.id && <CheckCircle2 className="w-3.5 h-3.5 mr-2 text-primary" />}
                  <span className={activeEnvId === env.id ? "" : "ml-[22px]"}>{env.name}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => openSettings(envLandingView)}>
                <Settings className="w-3.5 h-3.5 mr-2" /> Manage environments…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="h-5 w-px bg-border mx-2" />

          {/* Canvas actions - only when on canvas with flow */}
          {activeIsFlow && activeFlow && (
            <>
              {/* Run — split button: the main area runs immediately, the caret
                  offers running it a node at a time. */}
              <div className="flex items-stretch">
                <Button
                  variant="default"
                  size="sm"
                  disabled={isExecuting}
                  onClick={() => handleExecute("run")}
                  className="gap-1.5 rounded-r-none pr-2.5"
                  title="Run flow"
                >
                  {isExecuting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  {isExecuting ? "Running…" : "Run"}
                </Button>
                <div className="w-px bg-primary-foreground/25" />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="default"
                      size="sm"
                      disabled={isExecuting}
                      className="rounded-l-none px-1.5"
                      aria-label="More run options"
                      title="More run options"
                    >
                      <ChevronDown className="w-3 h-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => handleExecute("run")}>
                      <Play className="w-4 h-4 mr-2" /> Run
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleExecute("step")}>
                      <Footprints className="w-4 h-4 mr-2" /> Run step-by-step
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <div className="h-5 w-px bg-border mx-2" />

              {/* Undo/Redo group */}
              <Button variant="ghost" size="icon" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">
                <Undo2 className="w-4 h-4" />
              </Button>
              <Button variant="ghost" size="icon" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)">
                <Redo2 className="w-4 h-4" />
              </Button>

              <div className="h-5 w-px bg-border mx-2" />

              {/* Auto arrange — click arranges vertically, caret picks the axis */}
              <div className="flex items-stretch">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => requestAutoLayout('TB', layoutSpacing)}
                  title={`Auto arrange (top to bottom, ${layoutSpacing})`}
                >
                  <Network className="w-4 h-4" />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="w-5" title="Arrange options">
                      <ChevronDown className="w-3 h-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => requestAutoLayout('TB', layoutSpacing)}>
                      <MoveVertical className="w-4 h-4 mr-2" /> Arrange top to bottom
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => requestAutoLayout('LR', layoutSpacing)}>
                      <MoveHorizontal className="w-4 h-4 mr-2" /> Arrange left to right
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-[10px] font-normal text-muted-foreground">
                      Spacing
                    </DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={layoutSpacing}
                      onValueChange={(v) => setLayoutSpacing(v as LayoutSpacing)}
                    >
                      <DropdownMenuRadioItem value="comfortable">Comfortable</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="compact">Compact</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <div className="h-5 w-px bg-border mx-2" />

              {/* Validate/Export group */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setValidatorOpen(true)}
                    className="relative"
                  >
                    <CheckCircle2 className={cn(
                      "w-4 h-4",
                      validationStatus === 'validating' && "animate-pulse",
                      validationStatus === 'valid' && "text-green-500",
                      validationStatus === 'invalid' && "text-destructive"
                    )} />
                    <ValidationBadge
                      errorCount={validationErrors.length}
                      warningCount={validationWarnings.length}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs">
                  {validationStatus === 'validating' ? (
                    <p>Validating...</p>
                  ) : validationStatus === 'valid' ? (
                    <p>Flow is valid</p>
                  ) : validationErrors.length > 0 || validationWarnings.length > 0 ? (
                    <div className="space-y-1">
                      <p className="font-medium">
                        {validationErrors.length} error{validationErrors.length !== 1 ? 's' : ''}, {validationWarnings.length} warning{validationWarnings.length !== 1 ? 's' : ''}
                      </p>
                      <ul className="text-xs space-y-0.5">
                        {[...validationErrors, ...validationWarnings].slice(0, 3).map((issue, i) => (
                          <li key={i} className="truncate">• {issue.message}</li>
                        ))}
                        {validationErrors.length + validationWarnings.length > 3 && (
                          <li className="text-muted-foreground">...and {validationErrors.length + validationWarnings.length - 3} more</li>
                        )}
                      </ul>
                    </div>
                  ) : (
                    <p>Validate flow</p>
                  )}
                </TooltipContent>
              </Tooltip>
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
              {activeIsFlow && activeFlow && (
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
                        <AlignVerticalJustifyCenter className="h-4 w-4 mr-2" /> Align Horizontal Centers
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => alignNodes('center-v')}>
                        <AlignHorizontalJustifyCenter className="h-4 w-4 mr-2" /> Align Vertical Centers
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="text-[10px] font-normal text-muted-foreground">
                        Even spacing (3+ nodes)
                      </DropdownMenuLabel>
                      <DropdownMenuItem onClick={() => alignNodes('distribute-h')}>
                        <AlignHorizontalSpaceAround className="h-4 w-4 mr-2" /> Distribute Horizontally
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => alignNodes('distribute-v')}>
                        <AlignVerticalSpaceAround className="h-4 w-4 mr-2" /> Distribute Vertically
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setFlowVarsOpen(true)}>
                    Flow Variables...
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuLabel>Project</DropdownMenuLabel>
              <DropdownMenuItem onClick={openRunsTab}>
                <HistoryIcon className="w-4 h-4 mr-2" /> Run History
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openSettings()}>
                <Settings className="w-4 h-4 mr-2" /> Project Settings...
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

        </div>
      </header>

      {/* Main Content */}
      <div className="flex min-h-0 flex-1">
        {/* Far-left rail: what the sidebar shows. Below the header and beside the sidebar it
            controls, so the header keeps the back button, title and run controls. */}
        <ActivityRail
          view={railView}
          onSelect={setRailView}
          onOpenSettings={() => openSettings()}
          settingsActive={activeIsSettings}
        />

        <ResizablePanelGroup direction="horizontal" className="min-w-0 flex-1">
          {/* Left panel: one list, or the stacked Workspace view */}
          <ResizablePanel defaultSize={18} minSize={14} maxSize={26} className="min-w-[200px] max-w-[300px]">
            <div className="h-full bg-sidebar border-r border-sidebar-border">
              {renderSidebar(railView)}
            </div>
          </ResizablePanel>

          <ResizableHandle />

          {/* Tabbed workspace: pinned canvas + open test-case tabs */}
          <ResizablePanel defaultSize={78}>
            <div className="flex h-full flex-col">
              <WorkspaceTabs
                tabs={renderTabs}
                settingsOpen={workspace.settingsOpen}
                settingsDirty={dirtyTabs['settings']}
                runsOpen={workspace.runsOpen}
                active={workspace.active}
                onActivate={activateTab}
                onClose={requestCloseTab}
                onRename={handleRenameTab}
                onTogglePin={toggleRunPinned}
              />
              <div className="relative min-h-0 flex-1">
                {/* Every open test editor stays mounted (hidden unless active) so an
                    unsaved draft survives switching tabs. */}
                {workspace.tabs
                  .filter((t) => t.kind === 'test')
                  .map((t) => {
                    const key = tabKey('test', t.id);
                    const isActive = workspace.active === key;
                    return (
                      <div
                        key={key}
                        className="absolute inset-0"
                        style={{ display: isActive ? 'block' : 'none' }}
                        aria-hidden={!isActive}
                      >
                        <TestCaseEditor
                          testCaseId={t.id === '__new__' ? undefined : t.id}
                          isActive={isActive}
                          initialSubTab={editorSubTabRef.current[key]}
                          onSubTabChange={(tab) => persistEditorSubTab(key, tab)}
                          initialResult={(editorResultRef.current[key] as TestCaseExecutionResult | undefined) ?? null}
                          onResultChange={(result) => persistEditorResult(key, result)}
                          onDirtyChange={(dirty) => markTabDirty(key, dirty)}
                          onClose={() => requestCloseTab(key)}
                          onCreated={(newId) => {
                            doCloseTab(key);
                            openTestTab(newId);
                          }}
                        />
                      </div>
                    );
                  })}

                {/* Settings stays mounted for the same reason — unsaved edits there
                    must survive switching tabs. */}
                {workspace.settingsOpen && project && (
                  <div
                    className="absolute inset-0"
                    style={{ display: activeIsSettings ? 'block' : 'none' }}
                    aria-hidden={!activeIsSettings}
                  >
                    <SettingsPanel
                      project={project}
                      initialView={settingsInitialView}
                      onDirtyChange={(dirty) => markTabDirty('settings', dirty)}
                    />
                  </div>
                )}

                {/* Exactly one of these, chosen by kind. Everything above this point stays
                    mounted while hidden; everything here is mounted only while active.

                    Rendered only when there is something to render. An empty
                    `absolute inset-0` div is a transparent, full-size overlay, and it sits
                    after the kept-mounted editors in source order — so on a test or settings
                    tab it covered them and swallowed every click. The editor was visible and
                    untouchable. */}
                {surfaceContent && <div className="absolute inset-0">{surfaceContent}</div>}
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

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

      <FlowVariablesDialog
        open={flowVarsOpen}
        onOpenChange={setFlowVarsOpen}
        variables={flowVariables}
        onSave={setFlowVariables}
      />

      {pendingCloseKey && (
        <ConfirmDialog
          open
          onOpenChange={(o) => { if (!o) setPendingCloseKey(null); }}
          title="Discard unsaved changes?"
          description={`${
            pendingCloseKey === 'settings'
              ? 'Settings has'
              : `"${renderTabs.find((t) => t.key === pendingCloseKey)?.label ?? 'This tab'}" has`
          } changes that haven't been saved. Closing it will discard them.`}
          confirmLabel="Discard changes"
          cancelLabel="Keep editing"
          onConfirm={() => { doCloseTab(pendingCloseKey); setPendingCloseKey(null); }}
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
