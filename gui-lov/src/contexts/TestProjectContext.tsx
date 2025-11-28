import { createContext, useContext, useState, ReactNode, useCallback, useEffect } from "react";
import { Node, Edge } from "@xyflow/react";
import { useHistory } from "@/hooks/useHistory";
import { useAutoSave, SaveStatus } from "@/hooks/useAutoSave";
import { toast } from "sonner";
import type { Project, Flow as ApiFlow } from "@/lib/api/types";

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
}

export type NodeType = 'start' | 'end' | 'testCase' | 'group';

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

// Helper: Convert API Flow to internal TestGroup
function apiFlowToTestGroup(flow: ApiFlow): TestGroup {
  const nodes = flow.graph_data?.nodes?.map(n => ({
    id: n.id,
    type: n.type,  // API uses 'type' (backend serde rename)
    position: n.position,
    data: n.data,
  })) || [
    { id: `start-${flow.id}`, type: "start", position: { x: 250, y: 50 }, data: { label: "Start" } },
    { id: `end-${flow.id}`, type: "end", position: { x: 250, y: 480 }, data: { label: "End" } },
  ];

  const edges = flow.graph_data?.edges?.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
  })) || [];

  return {
    id: flow.id,
    name: flow.name,
    description: flow.description || undefined,
    expanded: true,
    version: flow.version,
    internalNodes: nodes,
    internalEdges: edges,
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
  const [showEdgeLabels, setShowEdgeLabels] = useState(true);
  const [showConsole, setShowConsole] = useState(true);
  const [snapToGrid, setSnapToGrid] = useState(false);
  const [edgeType, setEdgeType] = useState<'default' | 'straight' | 'step' | 'smoothstep'>('default');

  // Initialize from API flows or use defaults
  const initialTestGroups = initialFlows?.map(apiFlowToTestGroup) || defaultTestGroups;
  const [activeFlowId, setActiveFlowId] = useState<string | null>(
    initialTestGroups.length > 0 ? initialTestGroups[0].id : null
  );
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

  // Get active flow's nodes and edges
  const activeFlow = testGroups.find(g => g.id === activeFlowId);
  const nodes = activeFlow?.internalNodes || [];
  const edges = activeFlow?.internalEdges || [];

  // Get flow version from active flow for optimistic locking
  const flowVersion = activeFlow?.version ?? 1;

  // Callback to update flow version after save
  const handleVersionUpdate = useCallback((newVersion: number) => {
    if (!activeFlowId) return;
    setTestGroups(groups => groups.map(g =>
      g.id === activeFlowId ? { ...g, version: newVersion } : g
    ));
  }, [activeFlowId]);

  // Auto-save hook - watches nodes/edges changes and persists to backend
  const { status: saveStatus, lastSaved, error: saveError, save: manualSave } = useAutoSave({
    flowId: activeFlowId,
    version: flowVersion,
    nodes,
    edges,
    debounceMs: 2000,
    enabled: !!activeFlowId,
    onVersionUpdate: handleVersionUpdate,
  });

  const setNodes = useCallback((newNodes: Node[]) => {
    if (!activeFlowId) return;
    const updatedGroups = testGroups.map(g => 
      g.id === activeFlowId ? { ...g, internalNodes: newNodes } : g
    );
    history.pushState(testGroups, "Move nodes");
    setTestGroups(updatedGroups);
  }, [activeFlowId, testGroups, history]);

  const setEdges = useCallback((newEdges: Edge[]) => {
    if (!activeFlowId) return;
    const updatedGroups = testGroups.map(g => 
      g.id === activeFlowId ? { ...g, internalEdges: newEdges } : g
    );
    history.pushState(testGroups, "Update connections");
    setTestGroups(updatedGroups);
  }, [activeFlowId, testGroups, history]);

  const addTestGroup = useCallback((group: Omit<TestGroup, "id" | "testCases" | "expanded" | "version">) => {
    history.pushState(testGroups, `Add group: ${group.name}`);
    const newGroupId = `g${Date.now()}`;
    const newGroup: TestGroup = {
      ...group,
      id: newGroupId,
      testCases: [],
      expanded: true,
      version: 1,
      internalNodes: [
        {
          id: `start-${newGroupId}`,
          type: "start",
          position: { x: 250, y: 50 },
          data: { label: "Start" },
        },
        {
          id: `end-${newGroupId}`,
          type: "end",
          position: { x: 250, y: 480 },
          data: { label: "End" },
        },
      ],
      internalEdges: [],
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
      id: `t${Date.now()}`,
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
    history.pushState(testGroups, `Add node: ${data.label || nodeType}`);
    const newNode: Node = {
      id: data.testCaseId || data.groupId || `${nodeType}-${Date.now()}`,
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
