import { createContext, useContext, useState, ReactNode, useCallback, useEffect, useMemo } from "react";
import { Node, Edge, Viewport } from "@xyflow/react";
import { useSearchParams } from "react-router-dom";
import {
  WorkspaceState, initialWorkspaceState, MAX_TABS,
  openTest, openFlow, openSettings, openRuns, openSuite,
  openStorage, openFiles, openRun, togglePinned,
  closeTab as closeWsTab, setActive as setActiveWsTab,
} from "@/lib/workspaceTabs";
import { useHistory } from "@/hooks/useHistory";
import { useAutoSave, SaveStatus } from "@/hooks/useAutoSave";
import { useAutoValidate, ValidationStatus } from "@/hooks/useAutoValidate";
import {
  useExecutionStream,
  type ConsoleLog,
  type ExecuteFlowRequest,
  type RunMode,
  type StepCommand,
} from "@/hooks/useExecutionStream";
import type { LiveRun } from "@/lib/liveRun";
import type { TestCaseExecutionResult } from "@/lib/api/types";
import { toast } from "sonner";
import type { Project, Flow as ApiFlow, ValidationIssue } from "@/lib/api/types";
import { generateUUID } from "@/lib/utils/uuid";
import type { LayoutDirection, LayoutSpacing } from "@/lib/layoutUtils";
import { alignedPositions, minimumNodes, type AlignDirection } from "@/lib/alignNodes";
import {
  readGlobals, readEnvironments, effectiveEnv, mergeEnvWrites,
  getActiveEnvId, setActiveEnvId as persistActiveEnvId,
  type EnvVars, type Environment,
} from "@/lib/environments";
import { useUpdateProject } from "@/hooks/useApi";

export interface TestCase {
  id: string;
  name: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  endpoint?: string;
  headers?: string; // JSON string of headers object
  payload?: string;
  preTestScript?: string;
  postTestScript?: string;
  groupId: string;
}

export interface EdgeSettings {
  edgeType: 'default' | 'straight' | 'step' | 'smoothstep';
  showEdgeLabels: boolean;
  viewport?: Viewport;
}

export interface TestGroup {
  id: string;
  name: string;
  description?: string;
  testCases: TestCase[];
  expanded: boolean;
  version: number; // For optimistic locking
  // Internal flow graph for the group
  internalNodes?: Node[];
  internalEdges?: Edge[];
  // Edge settings per flow
  edgeSettings?: EdgeSettings;
  // Flow-level variables (scoped between project vars and node vars)
  flowVariables?: Record<string, unknown>;
}

export type NodeType = 'start' | 'end' | 'testCase' | 'group';

export type ActiveTab = 'canvas' | 'tests';
export type SidebarTab = 'tests' | 'flows';

interface TestProjectContextType {
  project: Project | null;
  projectId: string | null;
  testGroups: TestGroup[];
  nodes: Node[];
  edges: Edge[];
  showEdgeLabels: boolean;
  showConsole: boolean;
  snapToGrid: boolean;
  edgeType: 'default' | 'straight' | 'step' | 'smoothstep';
  activeFlowId: string | null;
  setActiveFlowId: (id: string | null) => void;
  // Tabbed workspace state (flow/test tabs + singleton settings; no pinned tab)
  workspace: WorkspaceState;
  openTestTab: (id: string) => void;
  openFlowTab: (id: string, canReuseActive: boolean) => void;
  openSettingsTab: () => void;
  /** Run history — one surface for the project, so a singleton like Settings. */
  openRunsTab: () => void;
  openSuiteTab: (id: string) => void;
  openStorageTab: (id: string) => void;
  openFilesTab: () => void;
  /** Open a run. Reuses the last unpinned run tab — runs are instances, and a debug loop
   *  should not cost a tab each time. */
  openRunTab: (id: string) => void;
  toggleRunPinned: (key: string) => void;
  closeWorkspaceTab: (key: string) => void;
  setActiveWorkspaceTab: (key: string) => void;
  // Environments & globals (per-user active env; SAT.env writes persist here)
  globals: EnvVars;
  environments: Environment[];
  activeEnvId: string | null;
  activeEnv: Environment | undefined;
  selectEnv: (id: string | null) => void;
  effectiveEnvironment: () => EnvVars;
  applyEnvWrites: (writes: Record<string, unknown>) => void;
  // Selection and editing state for test cases
  selectedTestCaseId: string | null;
  setSelectedTestCaseId: (id: string | null) => void;
  editingTestCaseId: string | null; // null = not editing, '__new__' = create mode, otherwise = edit mode
  setEditingTestCaseId: (id: string | null) => void;
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  sidebarTab: SidebarTab;
  setSidebarTab: (tab: SidebarTab) => void;
  openTestCaseEditor: (testCaseId?: string) => void; // No arg = create mode
  closeTestCaseEditor: () => void;
  // Auto-save status
  saveStatus: SaveStatus;
  lastSaved: Date | null;
  saveError: string | null;
  manualSave: () => Promise<boolean>;
  // Validation status
  validationStatus: ValidationStatus;
  validationErrors: ValidationIssue[];
  validationWarnings: ValidationIssue[];
  validateFlow: () => Promise<void>;
  invalidNodeIds: Set<string>;
  // Execution. Lives here rather than in the page because the canvas decorates its
  // nodes with it and each node's popover reports its own last run.
  logsByFlow: Record<string, ConsoleLog[]>;
  executingFlowId: string | null;
  isExecuting: boolean;
  executeFlow: (flowId: string, options?: ExecuteFlowRequest) => Promise<void>;
  /** Run a suite's members one after another. Logged under its own console key. */
  executeSuite: (suiteId: string, suiteName: string) => Promise<void>;
  cancelExecution: () => void;
  /** The suite run in flight, in the shape a stored run comes back in. */
  liveRun: LiveRun | null;
  clearLogs: (flowId: string) => void;
  closeLogs: (flowId: string) => void;
  /** Per flow, per node: what it did last time. Outlives the run. */
  nodeRuns: Record<string, Record<string, TestCaseExecutionResult>>;
  activeNodeId: string | null;
  pausedNodeId: string | null;
  runMode: RunMode;
  totalNodes: number;
  step: (command: StepCommand) => Promise<void>;
  addTestGroup: (group: Omit<TestGroup, "id" | "testCases" | "expanded">) => void;
  updateTestGroup: (id: string, updates: Partial<TestGroup>) => void;
  deleteTestGroup: (id: string) => void;
  addTestCase: (testCase: Omit<TestCase, "id">) => void;
  updateTestCase: (id: string, updates: Partial<TestCase>) => void;
  deleteTestCase: (id: string) => void;
  toggleGroup: (groupId: string) => void;
  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
  setShowEdgeLabels: (show: boolean) => void;
  setShowConsole: (show: boolean) => void;
  setSnapToGrid: (snap: boolean) => void;
  setEdgeType: (type: 'default' | 'straight' | 'step' | 'smoothstep') => void;
  setViewport: (viewport: Viewport) => void;
  getViewport: () => Viewport | undefined;
  syncNodeToSidebar: (nodeId: string, data: any) => void;
  addNodeToCanvas: (nodeType: NodeType, data: any, position: { x: number; y: number }) => void;
  updateGroupFlow: (groupId: string, nodes: Node[], edges: Edge[]) => void;
  deleteNodes: (nodeIds: string[]) => void;
  updateNodeConfig: (nodeId: string, config: any, alias?: string) => void;
  alignNodes: (direction: AlignDirection) => void;
  // Auto-layout is performed by the canvas (it owns fitView), so the toolbar
  // raises a request and TestCanvas applies it.
  layoutRequest: { direction: LayoutDirection; spacing: LayoutSpacing; seq: number } | null;
  requestAutoLayout: (direction: LayoutDirection, spacing?: LayoutSpacing) => void;
  flowVariables: Record<string, unknown>;
  setFlowVariables: (vars: Record<string, unknown>) => void;
  exportFlowJSON: (groupId: string) => any;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  lastAction: string | null;
}

const TestProjectContext = createContext<TestProjectContextType | undefined>(undefined);

export const useTestProject = () => {
  const context = useContext(TestProjectContext);
  if (!context) {
    throw new Error("useTestProject must be used within TestProjectProvider");
  }
  return context;
};

interface TestProjectProviderProps {
  children: ReactNode;
  projectId?: string;
  project?: Project;
  initialFlows?: ApiFlow[];
}

// Default edge settings
const defaultEdgeSettings: EdgeSettings = {
  edgeType: 'default',
  showEdgeLabels: true,
};

// Helper: Convert API Flow to internal TestGroup
function apiFlowToTestGroup(flow: ApiFlow): TestGroup {
  // Track seen IDs to detect and fix duplicates from old data
  const seenIds = new Set<string>();
  // Track ID remapping for updating edges when duplicates are found
  const idRemap = new Map<string, string>();

  const nodes = flow.graph_data?.nodes?.map(n => {
    let nodeId = n.id;
    // If we've seen this ID before, generate a unique one
    if (seenIds.has(nodeId)) {
      const newId = generateUUID();
      idRemap.set(nodeId, newId);
      nodeId = newId;
    }
    seenIds.add(nodeId);

    return {
      id: nodeId,
      type: n.type,  // API uses 'type' (backend serde rename)
      position: n.position,
      data: n.data,
    };
  }) || [
    { id: generateUUID(), type: "start", position: { x: 250, y: 50 }, data: { label: "Start" } },
    { id: generateUUID(), type: "end", position: { x: 250, y: 480 }, data: { label: "End" } },
  ];

  const edges = flow.graph_data?.edges?.map(e => ({
    id: e.id,
    // Update source/target if they were remapped due to duplicates
    source: idRemap.get(e.source) || e.source,
    target: idRemap.get(e.target) || e.target,
    label: e.label,
  })) || [];

  // Parse edge settings from graph_data.canvas_settings
  const canvasSettings = flow.graph_data?.canvas_settings || {};
  const edgeSettings: EdgeSettings = {
    edgeType: (canvasSettings.edgeType as EdgeSettings['edgeType']) || defaultEdgeSettings.edgeType,
    showEdgeLabels: canvasSettings.showEdgeLabels !== undefined
      ? Boolean(canvasSettings.showEdgeLabels)
      : defaultEdgeSettings.showEdgeLabels,
    viewport: canvasSettings.viewport as Viewport | undefined,
  };

  // Parse flow-level variables
  const flowVariables = (flow.graph_data?.variables as Record<string, unknown>) || {};

  return {
    id: flow.id,
    name: flow.name,
    description: flow.description || undefined,
    expanded: true,
    version: flow.version,
    internalNodes: nodes,
    internalEdges: edges,
    edgeSettings,
    flowVariables,
    testCases: [],
  };
}

// Default test groups when no flows from API
const defaultTestGroups: TestGroup[] = [];

export const TestProjectProvider = ({
  children,
  projectId,
  project,
  initialFlows
}: TestProjectProviderProps) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [showConsole, setShowConsole] = useState(true);
  const [snapToGrid, setSnapToGrid] = useState(false);

  // Initialize from API flows or use defaults
  const initialTestGroups = initialFlows?.map(apiFlowToTestGroup) || defaultTestGroups;

  // Get flow ID from URL, fallback to first flow
  const urlFlowId = searchParams.get('flow');
  const initialFlowId = urlFlowId && initialTestGroups.some(g => g.id === urlFlowId)
    ? urlFlowId
    : (initialTestGroups.length > 0 ? initialTestGroups[0].id : null);

  const [activeFlowId, setActiveFlowIdState] = useState<string | null>(initialFlowId);

  // Tabbed workspace: pinned canvas + open test-case tabs (persist across flow switches)
  const [workspace, setWorkspace] = useState<WorkspaceState>(initialWorkspaceState);
  /**
   * Open a test case as a tab, or bring its tab forward if it is already open.
   *
   * The "too many tabs" complaint lives here rather than at each call site: the reducer
   * already reports it, and every way of opening a test — the sidebar, a deep link, a
   * double-clicked node — owes the author the same answer. Computed outside the state
   * updater so the toast fires once, not once per invocation React chooses to make.
   */
  const openTestTab = useCallback((id: string) => {
    const { state, capped } = openTest(workspace, id);
    if (capped) {
      toast.warning(`Too many tabs open (max ${MAX_TABS}). Close one first.`);
      return;
    }
    setWorkspace(state);
  }, [workspace]);
  const openFlowTab = useCallback(
    (id: string, canReuseActive: boolean) => setWorkspace((s) => openFlow(s, id, { canReuseActive }).state),
    []
  );
  const openSettingsTab = useCallback(() => setWorkspace((s) => openSettings(s)), []);
  const openRunsTab = useCallback(() => setWorkspace((s) => openRuns(s)), []);
  const openRunTab = useCallback((id: string) => {
    setWorkspace((s) => {
      const { state, capped } = openRun(s, id);
      if (capped) toast.error(`Every run tab is pinned — unpin or close one (${MAX_TABS} is the limit)`);
      return state;
    });
  }, []);
  const toggleRunPinned = useCallback(
    (key: string) => setWorkspace((s) => togglePinned(s, key)),
    []
  );
  const openSuiteTab = useCallback((id: string) => {
    setWorkspace((s) => {
      const { state, capped } = openSuite(s, id);
      if (capped) toast.error(`Close a tab first — ${MAX_TABS} is the limit`);
      return state;
    });
  }, []);
  const openFilesTab = useCallback(() => setWorkspace((s) => openFiles(s)), []);
  const openStorageTab = useCallback((id: string) => {
    setWorkspace((s) => {
      const { state, capped } = openStorage(s, id);
      if (capped) toast.error(`Close a tab first — ${MAX_TABS} is the limit`);
      return state;
    });
  }, []);

  // Environments & globals — derived from project settings; active env per-user.
  const updateProjectMutation = useUpdateProject();
  const globals = useMemo(() => readGlobals(project?.settings), [project?.settings]);
  const environments = useMemo(() => readEnvironments(project?.settings), [project?.settings]);
  const [activeEnvId, setActiveEnvIdState] = useState<string | null>(
    () => (projectId ? getActiveEnvId(projectId) : null)
  );
  useEffect(() => {
    setActiveEnvIdState(projectId ? getActiveEnvId(projectId) : null);
  }, [projectId]);
  const activeEnv = environments.find((e) => e.id === activeEnvId);
  const selectEnv = useCallback((id: string | null) => {
    setActiveEnvIdState(id);
    if (projectId) persistActiveEnvId(projectId, id);
  }, [projectId]);
  const effectiveEnvironment = useCallback(
    () => effectiveEnv(globals, environments, activeEnvId),
    [globals, environments, activeEnvId]
  );
  // Persist SAT.env writes into the active environment (or Globals if none active).
  const applyEnvWrites = useCallback((writes: Record<string, unknown>) => {
    if (!project || !projectId || !writes || Object.keys(writes).length === 0) return;
    const settings = mergeEnvWrites(project.settings, activeEnvId, writes);
    updateProjectMutation.mutate({ id: projectId, data: { settings } });
  }, [project, projectId, activeEnvId, updateProjectMutation]);
  const closeWorkspaceTab = useCallback((key: string) => setWorkspace((s) => closeWsTab(s, key)), []);
  const setActiveWorkspaceTab = useCallback((key: string) => setWorkspace((s) => setActiveWsTab(s, key)), []);

  // Wrapper to update URL when active flow changes
  const setActiveFlowId = useCallback((id: string | null) => {
    setActiveFlowIdState(id);
    if (id) {
      setSearchParams(prev => {
        const newParams = new URLSearchParams(prev);
        newParams.set('flow', id);
        return newParams;
      }, { replace: true });
    } else {
      setSearchParams(prev => {
        const newParams = new URLSearchParams(prev);
        newParams.delete('flow');
        return newParams;
      }, { replace: true });
    }
  }, [setSearchParams]);

  // Selection and editing state for test cases
  const [selectedTestCaseId, setSelectedTestCaseId] = useState<string | null>(null);
  const [editingTestCaseId, setEditingTestCaseId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>('canvas');

  // Sidebar tab from URL, default to 'tests'
  const urlTab = searchParams.get('tab') as SidebarTab | null;
  const [sidebarTab, setSidebarTabState] = useState<SidebarTab>(
    urlTab === 'flows' ? 'flows' : 'tests'
  );

  // Wrapper to update URL when sidebar tab changes
  const setSidebarTab = useCallback((tab: SidebarTab) => {
    setSidebarTabState(tab);
    setSearchParams(prev => {
      const newParams = new URLSearchParams(prev);
      newParams.set('tab', tab);
      return newParams;
    }, { replace: true });
  }, [setSearchParams]);

  // Sync sidebarTab with URL when URL changes
  useEffect(() => {
    const urlTabCurrent = searchParams.get('tab') as SidebarTab | null;
    const newTab = urlTabCurrent === 'flows' ? 'flows' : 'tests';
    if (newTab !== sidebarTab) {
      setSidebarTabState(newTab);
    }
  }, [searchParams]);

  const history = useHistory<TestGroup[]>(50);
  const [testGroups, setTestGroups] = useState<TestGroup[]>(initialTestGroups);

  // Sync with API flows when they change
  useEffect(() => {
    if (initialFlows) {
      const newGroups = initialFlows.map(apiFlowToTestGroup);
      setTestGroups(newGroups);
      if (newGroups.length > 0 && !activeFlowId) {
        setActiveFlowId(newGroups[0].id);
      }
    }
  }, [initialFlows]);

  // Sync activeFlowId with URL when URL changes (e.g., from navigation)
  useEffect(() => {
    const urlFlowIdCurrent = searchParams.get('flow');
    if (urlFlowIdCurrent && urlFlowIdCurrent !== activeFlowId) {
      // Validate the flow exists before setting
      if (testGroups.some(g => g.id === urlFlowIdCurrent)) {
        setActiveFlowIdState(urlFlowIdCurrent);
      }
    }
  }, [searchParams, testGroups, activeFlowId]);

  // Get active flow's nodes, edges, and edge settings
  const activeFlow = testGroups.find(g => g.id === activeFlowId);
  const nodes = activeFlow?.internalNodes || [];
  const edges = activeFlow?.internalEdges || [];
  const edgeSettings = activeFlow?.edgeSettings || defaultEdgeSettings;
  const edgeType = edgeSettings.edgeType;
  const showEdgeLabels = edgeSettings.showEdgeLabels;
  const flowVariables = activeFlow?.flowVariables || {};

  const setFlowVariables = useCallback((vars: Record<string, unknown>) => {
    if (!activeFlowId) return;
    setTestGroups(prev => prev.map(g =>
      g.id === activeFlowId ? { ...g, flowVariables: vars } : g
    ));
  }, [activeFlowId]);

  // Get flow version from active flow for optimistic locking
  const flowVersion = activeFlow?.version ?? 1;

  // Callback to update flow version after save
  const handleVersionUpdate = useCallback((newVersion: number) => {
    if (!activeFlowId) return;
    setTestGroups(groups => groups.map(g =>
      g.id === activeFlowId ? { ...g, version: newVersion } : g
    ));
  }, [activeFlowId]);

  // Auto-save hook - watches nodes/edges/edgeSettings changes and persists to backend
  const { status: saveStatus, lastSaved, error: saveError, save: manualSave } = useAutoSave({
    flowId: activeFlowId,
    version: flowVersion,
    nodes,
    edges,
    edgeSettings,
    flowVariables,
    debounceMs: 2000,
    enabled: !!activeFlowId,
    onVersionUpdate: handleVersionUpdate,
  });

  // Auto-validate hook - validates on flow switch and structural changes
  const {
    status: validationStatus,
    errors: validationErrors,
    warnings: validationWarnings,
    validate: validateFlow,
    invalidNodeIds,
  } = useAutoValidate({
    flowId: activeFlowId,
    nodes,
    edges,
    debounceMs: 3000,
    enabled: !!activeFlowId,
  });

  // SSE streaming for real-time execution. onEnvWrites: a flow run persists SAT.env
  // writes to the active environment, the same as a standalone run.
  const {
    logsByFlow,
    executingFlowId,
    isExecuting,
    execute: executeFlow,
    executeSuite: runSuite,
    cancelExecution,
    liveRun,
    clearLogs,
    closeLogs,
    nodeRuns,
    activeNodeId,
    pausedNodeId,
    runMode,
    totalNodes,
    step,
  } = useExecutionStream({ onEnvWrites: applyEnvWrites });

  /**
   * Run a suite against the environment the author has selected.
   *
   * The environment is resolved here rather than by the caller. A flow run has one place
   * that assembles it (`handleRunFlow`); a suite has a Run button in its own editor, and
   * leaving that button to remember meant the first version sent none at all — so every
   * request resolved `{{baseUrl}}` from Globals, aimed at a dead port, and every node
   * errored identically. One caller forgetting is a bug; no caller being able to is not.
   */
  const executeSuite = useCallback(
    (suiteId: string, suiteName: string) =>
      runSuite(suiteId, suiteName, {
        debug_mode: true,
        environment: effectiveEnvironment(),
        // The run tab opens the moment the run has an id, so you watch the report fill in
        // rather than a spinner. A suite is a template; this is the instance.
        onRunId: (runId) => openRunTab(runId),
      }),
    [runSuite, effectiveEnvironment, openRunTab]
  );

  const setNodes = useCallback((newNodes: Node[]) => {
    if (!activeFlowId) return;
    // Use functional update to avoid stale closure issues
    setTestGroups(currentGroups => {
      history.pushState(currentGroups, "Move nodes");
      return currentGroups.map(g =>
        g.id === activeFlowId ? { ...g, internalNodes: newNodes } : g
      );
    });
  }, [activeFlowId, history]);

  const setEdges = useCallback((newEdges: Edge[]) => {
    if (!activeFlowId) return;
    // Use functional update to avoid stale closure issues
    setTestGroups(currentGroups => {
      history.pushState(currentGroups, "Update connections");
      return currentGroups.map(g =>
        g.id === activeFlowId ? { ...g, internalEdges: newEdges } : g
      );
    });
  }, [activeFlowId, history]);

  // Edge settings setters - update the active flow's edgeSettings
  const setEdgeType = useCallback((type: EdgeSettings['edgeType']) => {
    if (!activeFlowId) return;
    const updatedGroups = testGroups.map(g =>
      g.id === activeFlowId
        ? { ...g, edgeSettings: { ...(g.edgeSettings || defaultEdgeSettings), edgeType: type } }
        : g
    );
    history.pushState(testGroups, "Change edge type");
    setTestGroups(updatedGroups);
  }, [activeFlowId, testGroups, history]);

  const setShowEdgeLabels = useCallback((show: boolean) => {
    if (!activeFlowId) return;
    const updatedGroups = testGroups.map(g =>
      g.id === activeFlowId
        ? { ...g, edgeSettings: { ...(g.edgeSettings || defaultEdgeSettings), showEdgeLabels: show } }
        : g
    );
    history.pushState(testGroups, "Toggle edge labels");
    setTestGroups(updatedGroups);
  }, [activeFlowId, testGroups, history]);

  // Viewport setter - no history push as it's called frequently during pan/zoom
  const setViewport = useCallback((viewport: Viewport) => {
    if (!activeFlowId) return;
    setTestGroups(groups => groups.map(g =>
      g.id === activeFlowId
        ? { ...g, edgeSettings: { ...(g.edgeSettings || defaultEdgeSettings), viewport } }
        : g
    ));
  }, [activeFlowId]);

  // Get viewport for current flow
  const getViewport = useCallback((): Viewport | undefined => {
    const activeFlow = testGroups.find(g => g.id === activeFlowId);
    return activeFlow?.edgeSettings?.viewport;
  }, [testGroups, activeFlowId]);

  const addTestGroup = useCallback((group: Omit<TestGroup, "id" | "testCases" | "expanded" | "version">) => {
    history.pushState(testGroups, `Add group: ${group.name}`);
    const newGroupId = generateUUID();
    const newGroup: TestGroup = {
      ...group,
      id: newGroupId,
      testCases: [],
      expanded: true,
      version: 1,
      internalNodes: [
        {
          id: generateUUID(),
          type: "start",
          position: { x: 250, y: 50 },
          data: { label: "Start" },
        },
        {
          id: generateUUID(),
          type: "end",
          position: { x: 250, y: 480 },
          data: { label: "End" },
        },
      ],
      internalEdges: [],
      edgeSettings: defaultEdgeSettings,
    };
    setTestGroups([...testGroups, newGroup]);
    setActiveFlowId(newGroupId);
  }, [testGroups, history]);

  const updateTestGroup = useCallback((id: string, updates: Partial<TestGroup>) => {
    const group = testGroups.find(g => g.id === id);
    history.pushState(testGroups, `Update group: ${group?.name || id}`);
    setTestGroups(testGroups.map(g => g.id === id ? { ...g, ...updates } : g));
  }, [testGroups, history]);

  const deleteTestGroup = useCallback((id: string) => {
    const group = testGroups.find(g => g.id === id);
    history.pushState(testGroups, `Delete group: ${group?.name || id}`);
    setTestGroups(testGroups.filter(g => g.id !== id));
    if (activeFlowId === id) {
      const remaining = testGroups.filter(g => g.id !== id);
      setActiveFlowId(remaining.length > 0 ? remaining[0].id : null);
    }
  }, [testGroups, activeFlowId, history]);

  const addTestCase = useCallback((testCase: Omit<TestCase, "id">) => {
    history.pushState(testGroups, `Add test: ${testCase.name}`);
    const newTestCase: TestCase = {
      ...testCase,
      id: generateUUID(),
    };

    setTestGroups(testGroups.map(g => 
      g.id === testCase.groupId 
        ? { ...g, testCases: [...g.testCases, newTestCase] }
        : g
    ));
  }, [testGroups, history]);

  const updateTestCase = useCallback((id: string, updates: Partial<TestCase>) => {
    const testCase = testGroups.flatMap(g => g.testCases).find(tc => tc.id === id);
    history.pushState(testGroups, `Update test: ${testCase?.name || id}`);
    setTestGroups(testGroups.map(g => ({
      ...g,
      testCases: g.testCases.map(tc => tc.id === id ? { ...tc, ...updates } : tc),
    })));

    // Sync to canvas
    setNodes(nodes.map(n => 
      n.id === id 
        ? { 
            ...n, 
            data: { 
              ...n.data, 
              label: updates.name || n.data.label,
              method: updates.method || n.data.method,
              endpoint: updates.endpoint || n.data.endpoint,
              headers: updates.headers !== undefined ? updates.headers : n.data.headers,
              payload: updates.payload !== undefined ? updates.payload : n.data.payload,
              preTestScript: updates.preTestScript !== undefined ? updates.preTestScript : n.data.preTestScript,
              postTestScript: updates.postTestScript !== undefined ? updates.postTestScript : n.data.postTestScript
            } 
          }
        : n
    ));
  }, [testGroups, nodes, setNodes, history]);

  const deleteTestCase = useCallback((id: string) => {
    const testCase = testGroups.flatMap(g => g.testCases).find(tc => tc.id === id);
    history.pushState(testGroups, `Delete test: ${testCase?.name || id}`);
    setTestGroups(testGroups.map(g => ({
      ...g,
      testCases: g.testCases.filter(tc => tc.id !== id),
    })));

    // Remove from canvas
    setNodes(nodes.filter(n => n.id !== id));
    setEdges(edges.filter(e => e.source !== id && e.target !== id));
  }, [testGroups, nodes, edges, setNodes, setEdges, history]);

  const toggleGroup = (groupId: string) => {
    setTestGroups(testGroups.map(g => 
      g.id === groupId ? { ...g, expanded: !g.expanded } : g
    ));
  };

  const addNodeToCanvas = useCallback((nodeType: NodeType, data: any, position: { x: number; y: number }) => {
    if (!activeFlowId) return;

    // Prevent dropping a flow into itself (circular reference)
    if (nodeType === 'group' && data.flowId === activeFlowId) {
      toast.error("Cannot add a flow into itself");
      return;
    }

    history.pushState(testGroups, `Add node: ${data.label || nodeType}`);
    // Always generate a unique node ID (allows same test case multiple times in flow)
    // The testCaseId/groupId is preserved in data for reference
    const newNode: Node = {
      id: generateUUID(),
      type: nodeType,
      position,
      data,
    };
    setNodes([...nodes, newNode]);
  }, [activeFlowId, nodes, setNodes, testGroups, history]);

  const updateGroupFlow = (groupId: string, internalNodes: Node[], internalEdges: Edge[]) => {
    setTestGroups(testGroups.map(group => 
      group.id === groupId 
        ? { ...group, internalNodes, internalEdges }
        : group
    ));
  };

  const syncNodeToSidebar = (nodeId: string, data: any) => {
    // Update sidebar when node is edited on canvas
    updateTestCase(nodeId, {
      name: data.label,
      method: data.method,
      endpoint: data.endpoint,
      headers: data.headers,
      payload: data.payload,
      preTestScript: data.preTestScript,
      postTestScript: data.postTestScript,
    });
  };

  /**
   * Delete nodes and every edge touching them.
   *
   * Takes a list rather than one id because deleting a selection has to be one
   * update: this closes over `nodes`, so calling a single-node version in a loop
   * would hand each call the same stale array and only the last would survive.
   * One history entry too — undo puts the whole selection back.
   */
  const deleteNodes = useCallback((nodeIds: string[]) => {
    if (!activeFlowId || nodeIds.length === 0) return;
    const doomed = new Set(nodeIds);
    const only = nodeIds.length === 1 ? nodes.find(n => n.id === nodeIds[0]) : null;
    history.pushState(
      testGroups,
      only
        ? `Delete node: ${only.data?.label || nodeIds[0]}`
        : `Delete ${nodeIds.length} nodes`,
    );
    setNodes(nodes.filter(n => !doomed.has(n.id)));
    setEdges(edges.filter(e => !doomed.has(e.source) && !doomed.has(e.target)));
  }, [activeFlowId, nodes, edges, setNodes, setEdges, testGroups, history]);

  const updateNodeConfig = useCallback((nodeId: string, config: any, alias?: string) => {
    if (!activeFlowId) return;
    const node = nodes.find(n => n.id === nodeId);
    history.pushState(testGroups, `Configure node: ${node?.data?.label || nodeId}`);
    // A blank alias clears the name rather than storing "" — the node falls back
    // to the test case name, which is also what the engine does with a blank.
    const trimmed = alias?.trim();
    setNodes(nodes.map(n =>
      n.id === nodeId
        ? { ...n, data: { ...n.data, config, alias: trimmed || undefined } }
        : n
    ));
  }, [activeFlowId, nodes, setNodes, testGroups, history]);

  const alignNodes = useCallback((direction: AlignDirection) => {
    const selectedNodes = nodes.filter(n => n.selected);
    const needed = minimumNodes(direction);
    if (selectedNodes.length < needed) {
      toast.error(
        needed === 3
          ? 'Select at least 3 nodes to distribute'
          : 'Select at least 2 nodes to align'
      );
      return;
    }

    history.pushState(testGroups, `Align nodes: ${direction}`);
    // The geometry lives in lib/alignNodes — edges and centres, not origins.
    const moved = alignedPositions(selectedNodes, direction);
    setNodes(nodes.map(n => (moved[n.id] ? { ...n, position: moved[n.id] } : n)));
    toast.success(`Aligned nodes: ${direction}`);
  }, [nodes, setNodes, testGroups, history]);

  // Auto-layout: snapshot for undo here, then let the canvas do the arranging.
  const [layoutRequest, setLayoutRequest] = useState<{ direction: LayoutDirection; spacing: LayoutSpacing; seq: number } | null>(null);
  const requestAutoLayout = useCallback((direction: LayoutDirection, spacing: LayoutSpacing = 'comfortable') => {
    if (nodes.length === 0) {
      toast.error('Nothing to arrange');
      return;
    }
    history.pushState(testGroups, `Auto layout: ${direction === 'TB' ? 'vertical' : 'horizontal'}`);
    setLayoutRequest((prev) => ({ direction, spacing, seq: (prev?.seq ?? 0) + 1 }));
  }, [nodes.length, testGroups, history]);

  const undo = useCallback(() => {
    const previousState = history.undo();
    if (previousState) {
      setTestGroups(previousState);
      toast.success(`Undone: ${history.lastAction || 'Action'}`);
    }
  }, [history]);

  const redo = useCallback(() => {
    const nextState = history.redo();
    if (nextState) {
      setTestGroups(nextState);
      toast.success(`Redone: ${history.lastAction || 'Action'}`);
    }
  }, [history]);

  const exportFlowJSON = useCallback((groupId: string) => {
    const group = testGroups.find(g => g.id === groupId);
    if (!group) return null;

    return {
      flowId: group.id,
      name: group.name,
      description: group.description,
      nodes: (group.internalNodes || []).map(node => ({
        id: node.id,
        type: node.type,
        position: node.position,
        data: {
          label: node.data.label,
          testCaseId: node.data.testCaseId,
          method: node.data.method,
          endpoint: node.data.endpoint,
          headers: node.data.headers,
          payload: node.data.payload,
          preTestScript: node.data.preTestScript,
          postTestScript: node.data.postTestScript,
          config: node.data.config,
        },
      })),
      edges: (group.internalEdges || []).map(edge => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label,
      })),
      testCases: group.testCases,
      metadata: {
        createdAt: new Date().toISOString(),
        version: '1.0',
      },
    };
  }, [testGroups]);

  // Helper functions for test case editor
  const openTestCaseEditor = useCallback((testCaseId?: string) => {
    if (testCaseId) {
      // Edit mode
      setSelectedTestCaseId(testCaseId);
      setEditingTestCaseId(testCaseId);
    } else {
      // Create mode - use special marker
      setSelectedTestCaseId(null);
      setEditingTestCaseId('__new__');
    }
    setActiveTab('tests');
  }, []);

  const closeTestCaseEditor = useCallback(() => {
    setEditingTestCaseId(null);
    setActiveTab('canvas');
  }, []);

  return (
    <TestProjectContext.Provider
      value={{
        project: project || null,
        projectId: projectId || null,
        globals,
        environments,
        activeEnvId,
        activeEnv,
        selectEnv,
        effectiveEnvironment,
        applyEnvWrites,
        testGroups,
        nodes,
        edges,
        showEdgeLabels,
        showConsole,
        snapToGrid,
        edgeType,
        activeFlowId,
        setActiveFlowId,
        workspace,
        openTestTab,
        openFlowTab,
        openSettingsTab,
        openRunsTab,
        openSuiteTab,
        openStorageTab,
        openFilesTab,
        openRunTab,
        toggleRunPinned,
        closeWorkspaceTab,
        setActiveWorkspaceTab,
        selectedTestCaseId,
        setSelectedTestCaseId,
        editingTestCaseId,
        setEditingTestCaseId,
        activeTab,
        setActiveTab,
        sidebarTab,
        setSidebarTab,
        openTestCaseEditor,
        closeTestCaseEditor,
        saveStatus,
        lastSaved,
        saveError,
        manualSave,
        validationStatus,
        validationErrors,
        validationWarnings,
        validateFlow,
        invalidNodeIds,
        logsByFlow,
        executingFlowId,
        isExecuting,
        executeFlow,
        executeSuite,
        cancelExecution,
        liveRun,
        clearLogs,
        closeLogs,
        nodeRuns,
        activeNodeId,
        pausedNodeId,
        runMode,
        totalNodes,
        step,
        addTestGroup,
        updateTestGroup,
        deleteTestGroup,
        addTestCase,
        updateTestCase,
        deleteTestCase,
        toggleGroup,
        setNodes,
        setEdges,
        setShowEdgeLabels,
        setShowConsole,
        setSnapToGrid,
        setEdgeType,
        setViewport,
        getViewport,
        syncNodeToSidebar,
        addNodeToCanvas,
        updateGroupFlow,
        deleteNodes,
        updateNodeConfig,
        alignNodes,
        layoutRequest,
        requestAutoLayout,
        flowVariables,
        setFlowVariables,
        exportFlowJSON,
        undo,
        redo,
        canUndo: history.canUndo,
        canRedo: history.canRedo,
        lastAction: history.lastAction,
      }}
    >
      {children}
    </TestProjectContext.Provider>
  );
};
