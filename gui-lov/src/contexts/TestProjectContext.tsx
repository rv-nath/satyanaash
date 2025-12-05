import { createContext, useContext, useState, ReactNode, useCallback, useEffect } from "react";
import { Node, Edge, Viewport } from "@xyflow/react";
import { useSearchParams } from "react-router-dom";
import { useHistory } from "@/hooks/useHistory";
import { useAutoSave, SaveStatus } from "@/hooks/useAutoSave";
import { toast } from "sonner";
import type { Project, Flow as ApiFlow } from "@/lib/api/types";
import { generateUUID } from "@/lib/utils/uuid";

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
  manualSave: () => Promise<void>;
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
  deleteNode: (nodeId: string) => void;
  updateNodeConfig: (nodeId: string, config: any) => void;
  alignNodes: (direction: 'left' | 'right' | 'top' | 'bottom' | 'center-h' | 'center-v' | 'distribute-h' | 'distribute-v') => void;
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

  return {
    id: flow.id,
    name: flow.name,
    description: flow.description || undefined,
    expanded: true,
    version: flow.version,
    internalNodes: nodes,
    internalEdges: edges,
    edgeSettings,
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
    debounceMs: 2000,
    enabled: !!activeFlowId,
    onVersionUpdate: handleVersionUpdate,
  });

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

  const deleteNode = useCallback((nodeId: string) => {
    if (!activeFlowId) return;
    const node = nodes.find(n => n.id === nodeId);
    history.pushState(testGroups, `Delete node: ${node?.data?.label || nodeId}`);
    // Remove node from canvas
    setNodes(nodes.filter(n => n.id !== nodeId));
    // Remove all connected edges
    setEdges(edges.filter(e => e.source !== nodeId && e.target !== nodeId));
  }, [activeFlowId, nodes, edges, setNodes, setEdges, testGroups, history]);

  const updateNodeConfig = useCallback((nodeId: string, config: any) => {
    if (!activeFlowId) return;
    const node = nodes.find(n => n.id === nodeId);
    history.pushState(testGroups, `Configure node: ${node?.data?.label || nodeId}`);
    setNodes(nodes.map(n => 
      n.id === nodeId 
        ? { ...n, data: { ...n.data, config } }
        : n
    ));
  }, [activeFlowId, nodes, setNodes, testGroups, history]);

  const alignNodes = useCallback((direction: 'left' | 'right' | 'top' | 'bottom' | 'center-h' | 'center-v' | 'distribute-h' | 'distribute-v') => {
    const selectedNodes = nodes.filter(n => n.selected);
    if (selectedNodes.length < 2) {
      toast.error('Select at least 2 nodes to align');
      return;
    }

    history.pushState(testGroups, `Align nodes: ${direction}`);
    
    const updatedNodes = [...nodes];
    
    if (direction === 'left') {
      const minX = Math.min(...selectedNodes.map(n => n.position.x));
      selectedNodes.forEach(node => {
        const idx = updatedNodes.findIndex(n => n.id === node.id);
        updatedNodes[idx] = { ...updatedNodes[idx], position: { ...updatedNodes[idx].position, x: minX } };
      });
    } else if (direction === 'right') {
      const maxX = Math.max(...selectedNodes.map(n => n.position.x));
      selectedNodes.forEach(node => {
        const idx = updatedNodes.findIndex(n => n.id === node.id);
        updatedNodes[idx] = { ...updatedNodes[idx], position: { ...updatedNodes[idx].position, x: maxX } };
      });
    } else if (direction === 'top') {
      const minY = Math.min(...selectedNodes.map(n => n.position.y));
      selectedNodes.forEach(node => {
        const idx = updatedNodes.findIndex(n => n.id === node.id);
        updatedNodes[idx] = { ...updatedNodes[idx], position: { ...updatedNodes[idx].position, y: minY } };
      });
    } else if (direction === 'bottom') {
      const maxY = Math.max(...selectedNodes.map(n => n.position.y));
      selectedNodes.forEach(node => {
        const idx = updatedNodes.findIndex(n => n.id === node.id);
        updatedNodes[idx] = { ...updatedNodes[idx], position: { ...updatedNodes[idx].position, y: maxY } };
      });
    } else if (direction === 'center-h') {
      const avgX = selectedNodes.reduce((sum, n) => sum + n.position.x, 0) / selectedNodes.length;
      selectedNodes.forEach(node => {
        const idx = updatedNodes.findIndex(n => n.id === node.id);
        updatedNodes[idx] = { ...updatedNodes[idx], position: { ...updatedNodes[idx].position, x: avgX } };
      });
    } else if (direction === 'center-v') {
      const avgY = selectedNodes.reduce((sum, n) => sum + n.position.y, 0) / selectedNodes.length;
      selectedNodes.forEach(node => {
        const idx = updatedNodes.findIndex(n => n.id === node.id);
        updatedNodes[idx] = { ...updatedNodes[idx], position: { ...updatedNodes[idx].position, y: avgY } };
      });
    } else if (direction === 'distribute-h') {
      const sorted = [...selectedNodes].sort((a, b) => a.position.x - b.position.x);
      const minX = sorted[0].position.x;
      const maxX = sorted[sorted.length - 1].position.x;
      const gap = (maxX - minX) / (sorted.length - 1);
      sorted.forEach((node, i) => {
        const idx = updatedNodes.findIndex(n => n.id === node.id);
        updatedNodes[idx] = { ...updatedNodes[idx], position: { ...updatedNodes[idx].position, x: minX + (gap * i) } };
      });
    } else if (direction === 'distribute-v') {
      const sorted = [...selectedNodes].sort((a, b) => a.position.y - b.position.y);
      const minY = sorted[0].position.y;
      const maxY = sorted[sorted.length - 1].position.y;
      const gap = (maxY - minY) / (sorted.length - 1);
      sorted.forEach((node, i) => {
        const idx = updatedNodes.findIndex(n => n.id === node.id);
        updatedNodes[idx] = { ...updatedNodes[idx], position: { ...updatedNodes[idx].position, y: minY + (gap * i) } };
      });
    }
    
    setNodes(updatedNodes);
    toast.success(`Aligned nodes: ${direction}`);
  }, [nodes, setNodes, testGroups, history]);

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
        testGroups,
        nodes,
        edges,
        showEdgeLabels,
        showConsole,
        snapToGrid,
        edgeType,
        activeFlowId,
        setActiveFlowId,
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
        deleteNode,
        updateNodeConfig,
        alignNodes,
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
