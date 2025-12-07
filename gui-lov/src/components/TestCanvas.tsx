import { useCallback, useState, useEffect, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Connection,
  addEdge,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  ReactFlowProvider,
  Node,
  ConnectionMode,
  Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTestProject } from "@/contexts/TestProjectContext";
import { TestCaseNode, StartNode, EndNode, GroupNode } from "./CustomNodes";
import { CanvasContextMenu } from "./CanvasContextMenu";
import { NodeConfigPanel } from "./NodeConfigPanel";
import { EdgeTypeDialog } from "./EdgeTypeDialog";
import { getLayoutedElements } from "@/lib/layoutUtils";
import { useReactFlow } from "@xyflow/react";

const nodeTypes = {
  testCase: TestCaseNode,
  start: StartNode,
  end: EndNode,
  group: GroupNode,
};

const TestCanvasContent = () => {
  const { nodes: contextNodes, edges: contextEdges, setNodes, setEdges, showEdgeLabels, edgeType, addNodeToCanvas, testGroups, deleteNode, activeFlowId, undo, redo, snapToGrid, setViewport, getViewport, invalidNodeIds, validationErrors } = useTestProject();
  const [nodes, setNodesState, onNodesChange] = useNodesState(contextNodes);
  const [edges, setEdgesState, onEdgesChange] = useEdgesState(contextEdges);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [showConfigPanel, setShowConfigPanel] = useState(false);
  const [pendingConnection, setPendingConnection] = useState<Connection | null>(null);
  const [showEdgeTypeDialog, setShowEdgeTypeDialog] = useState(false);
  const { fitView, setViewport: setReactFlowViewport, getViewport: getReactFlowViewport } = useReactFlow();
  const viewportDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const isRestoringViewportRef = useRef(false);
  const lastActiveFlowIdRef = useRef<string | null>(null);

  // Apply edge type to all edges
  const edgesWithType = edges.map(edge => ({
    ...edge,
    type: edgeType,
  }));

  const onConnectStart = useCallback((event: any, params: any) => {
    console.log('🟢 onConnectStart:', params);
  }, []);

  const onConnectEnd = useCallback((event: any) => {
    console.log('🔴 onConnectEnd:', event);
  }, []);
  
  // Determine execution mode
  const hasCustomFlow = nodes.some(n => n.type === 'testCase' || n.type === 'group');
  const hasAnyNodes = nodes.length > 0;
  const executionMode = hasCustomFlow ? 'flow' : 'fifo';
  const totalTests = testGroups.reduce((sum, g) => sum + g.testCases.length, 0);
  const [contextMenu, setContextMenu] = useState<{ 
    x: number; 
    y: number; 
    canvasPosition?: { x: number; y: number } 
  } | null>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<any>(null);

  // Sync context changes to local state
  useEffect(() => {
    setNodesState(contextNodes);
  }, [contextNodes, setNodesState]);

  useEffect(() => {
    setEdgesState(contextEdges);
  }, [contextEdges, setEdgesState]);

  // Restore viewport when active flow changes
  useEffect(() => {
    if (!activeFlowId || activeFlowId === lastActiveFlowIdRef.current) return;
    lastActiveFlowIdRef.current = activeFlowId;

    // Get saved viewport for this flow
    const savedViewport = getViewport();
    if (savedViewport) {
      isRestoringViewportRef.current = true;
      setReactFlowViewport(savedViewport, { duration: 200 });
      // Reset flag after animation
      setTimeout(() => {
        isRestoringViewportRef.current = false;
      }, 250);
    }
  }, [activeFlowId, getViewport, setReactFlowViewport]);

  // Handle viewport changes (debounced to avoid too many saves)
  const handleMoveEnd = useCallback((_event: MouseEvent | TouchEvent | null, viewport: Viewport) => {
    // Skip if we're restoring viewport (not a user action)
    if (isRestoringViewportRef.current) return;

    // Clear existing debounce timer
    if (viewportDebounceRef.current) {
      clearTimeout(viewportDebounceRef.current);
    }

    // Debounce viewport save to avoid excessive saves during pan/zoom
    viewportDebounceRef.current = setTimeout(() => {
      setViewport(viewport);
    }, 500);
  }, [setViewport]);

  // Cleanup viewport debounce timer
  useEffect(() => {
    return () => {
      if (viewportDebounceRef.current) {
        clearTimeout(viewportDebounceRef.current);
      }
    };
  }, []);

  // Sync local state changes back to context immediately after changes settle
  const handleNodesChange = useCallback((changes: any) => {
    onNodesChange(changes);
    // Use requestAnimationFrame for smooth sync without flickering
    requestAnimationFrame(() => {
      setNodesState((currentNodes) => {
        // Apply snap to grid if enabled
        const snappedNodes = snapToGrid 
          ? currentNodes.map(node => ({
              ...node,
              position: {
                x: Math.round(node.position.x / 20) * 20,
                y: Math.round(node.position.y / 20) * 20,
              }
            }))
          : currentNodes;
        setNodes(snappedNodes);
        return snappedNodes;
      });
    });
  }, [setNodes, onNodesChange, setNodesState, snapToGrid]);

  const handleEdgesChange = useCallback((changes: any) => {
    onEdgesChange(changes);
    requestAnimationFrame(() => {
      setEdgesState((currentEdges) => {
        setEdges(currentEdges);
        return currentEdges;
      });
    });
  }, [setEdges, onEdgesChange, setEdgesState]);

  const onConnect = useCallback(
    (connection: Connection) => {
      console.log('onConnect triggered:', connection);
      // Store the pending connection and show dialog
      setPendingConnection(connection);
      setShowEdgeTypeDialog(true);
    },
    []
  );

  const onReconnect = useCallback(
    (oldEdge: any, newConnection: Connection) => {
      console.log('onReconnect triggered:', oldEdge, newConnection);
      // Keep the same edge type and style when reconnecting
      const updatedEdges = edges.map(edge => {
        if (edge.id === oldEdge.id) {
          return {
            ...edge,
            source: newConnection.source!,
            target: newConnection.target!,
            sourceHandle: newConnection.sourceHandle,
            targetHandle: newConnection.targetHandle,
          };
        }
        return edge;
      });
      setEdgesState(updatedEdges);
      setEdges(updatedEdges);
    },
    [edges, setEdges, setEdgesState]
  );

  const handleEdgeTypeSelect = useCallback(
    (type: 'success' | 'failure') => {
      console.log('handleEdgeTypeSelect triggered:', type, pendingConnection);
      if (!pendingConnection) return;
      
      const newEdge = {
        ...pendingConnection,
        animated: true,
        data: { type },
        label: type === 'success' ? 'Success' : 'Failure',
        style: { 
          stroke: type === 'success' ? 'hsl(var(--success))' : 'hsl(var(--destructive))' 
        },
      };
      const newEdges = addEdge(newEdge, edges);
      console.log('Edge created, new edges:', newEdges);
      setEdgesState(newEdges);
      setEdges(newEdges);
      setShowEdgeTypeDialog(false);
      setPendingConnection(null);
    },
    [pendingConnection, edges, setEdges, setEdgesState]
  );

  const handleEdgeTypeCancel = useCallback(() => {
    setShowEdgeTypeDialog(false);
    setPendingConnection(null);
  }, []);

  const handleAutoLayout = useCallback(() => {
    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(nodes, edges);
    setNodesState(layoutedNodes);
    setNodes(layoutedNodes);
    setEdgesState(layoutedEdges);
    setEdges(layoutedEdges);
    
    // Fit view after layout with a small delay to ensure layout is applied
    setTimeout(() => {
      fitView({ padding: 0.2, duration: 400 });
    }, 50);
  }, [nodes, edges, setNodesState, setNodes, setEdgesState, setEdges, fitView]);

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    // Calculate canvas position for node placement
    const canvasPosition = {
      x: event.clientX - 250, // Approximate offset
      y: event.clientY - 100,
    };
    setContextMenu({ 
      x: event.clientX, 
      y: event.clientY,
      canvasPosition 
    });
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    
    if (!reactFlowInstance) return;

    try {
      const data = JSON.parse(event.dataTransfer.getData('application/json'));
      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      
      addNodeToCanvas(data.type, data.data, position);
    } catch (error) {
      console.error('Error dropping node:', error);
    }
  }, [reactFlowInstance, addNodeToCanvas]);

  // Handle keyboard shortcuts (delete, undo, redo)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Skip if user is typing in an input field
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        return;
      }

      // Undo: Ctrl+Z (Cmd+Z on Mac)
      if ((event.ctrlKey || event.metaKey) && event.key === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
        return;
      }

      // Redo: Ctrl+Y or Ctrl+Shift+Z (Cmd+Shift+Z on Mac)
      if ((event.ctrlKey || event.metaKey) && (event.key === 'y' || (event.shiftKey && event.key === 'z'))) {
        event.preventDefault();
        redo();
        return;
      }

      // Delete nodes/edges (check both event.key and event.code for cross-browser support)
      const isDelete = event.key === 'Delete' || event.code === 'Delete';
      const isBackspace = event.key === 'Backspace' || event.code === 'Backspace';

      if (isDelete || isBackspace) {
        event.preventDefault();
        if (selectedNode) {
          deleteNode(selectedNode.id);
          setSelectedNode(null);
        } else if (selectedEdge) {
          const updatedEdges = edges.filter(e => e.id !== selectedEdge);
          setEdgesState(updatedEdges);
          setEdges(updatedEdges);
          setSelectedEdge(null);
        }
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedNode, selectedEdge, deleteNode, edges, setEdges, setEdgesState, undo, redo]);

  const handleNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setSelectedNode(node);
    setSelectedEdge(null);
    setShowConfigPanel(false);
  }, []);

  const handleEdgeClick = useCallback((_event: React.MouseEvent, edge: any) => {
    // Clicking an edge brings it to front by selecting it
    setSelectedEdge(edge.id);
    setSelectedNode(null);
    setShowConfigPanel(false);
  }, []);

  const handleEdgeMouseEnter = useCallback((_event: React.MouseEvent, edge: any) => {
    // Hovering brings edge to front if no edge is currently selected
    if (!selectedEdge) {
      setSelectedEdge(edge.id);
    }
  }, [selectedEdge]);

  const handleEdgeMouseLeave = useCallback(() => {
    // Clear hover selection when mouse leaves (but keep if it was clicked)
  }, []);

  const handlePaneClick = useCallback(() => {
    setSelectedNode(null);
    setSelectedEdge(null);
    setShowConfigPanel(false);
  }, []);

  // Apply node styling for selection, validation highlighting, and edge styling based on type
  const styledNodes = nodes.map(node => {
    const hasValidationIssue = invalidNodeIds.has(node.id);
    const isError = hasValidationIssue && validationErrors.some(e => e.node_id === node.id);
    const validationClass = hasValidationIssue
      ? (isError ? 'validation-error' : 'validation-warning')
      : '';

    return {
      ...node,
      selected: node.id === selectedNode?.id,
      className: [node.className, validationClass].filter(Boolean).join(' '),
      style: {
        ...node.style,
        border: node.id === selectedNode?.id ? '2px solid hsl(var(--primary))' : undefined,
        boxShadow: node.id === selectedNode?.id ? '0 0 0 2px hsl(var(--primary) / 0.2)' : undefined,
      },
    };
  });

  // Sort edges so selected/hovered ones are on top (rendered last)
  const styledEdges = edgesWithType
    .map(edge => ({
      ...edge,
      label: showEdgeLabels ? edge.label : undefined,
      selected: edge.id === selectedEdge,
      reconnectable: 'target',
      interactionWidth: 30,
      className: 'hover:!stroke-[4px] transition-all cursor-pointer',
      style: {
        ...edge.style,
        stroke: edge.data?.type === 'failure' 
          ? 'hsl(var(--destructive))' 
          : 'hsl(var(--success))',
        strokeWidth: edge.id === selectedEdge ? 4 : 2,
      },
    }))
    .sort((a, b) => {
      // Selected edge goes to end (top layer)
      if (a.id === selectedEdge) return 1;
      if (b.id === selectedEdge) return -1;
      return 0;
    });

  const activeFlow = testGroups.find(g => g.id === activeFlowId);

  return (
    <div 
      className="h-full w-full bg-canvas relative" 
      onContextMenu={handleContextMenu}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Empty State */}
      {!hasAnyNodes && activeFlow && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-0">
          <div className="text-center max-w-md mx-auto px-6">
            <div className="text-6xl mb-4">🎯</div>
            <h3 className="text-xl font-semibold text-foreground mb-2">
              Build Your Flow
            </h3>
            <p className="text-muted-foreground mb-4">
              Drag test cases from the Tests tab to create a custom execution flow.
            </p>
            <div className="bg-muted/30 border border-border rounded-lg p-4 text-left">
              <p className="text-sm text-muted-foreground">
                💡 <strong>How to build a flow:</strong>
              </p>
              <ul className="text-sm text-muted-foreground mt-2 space-y-1 ml-4">
                <li>• Switch to the <strong>Tests</strong> tab on the left</li>
                <li>• Drag test cases onto this canvas</li>
                <li>• Connect nodes to define execution order</li>
                <li>• Connect Start → tests → End</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      <ReactFlow
        nodes={styledNodes}
        edges={styledEdges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        onReconnect={onReconnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        onEdgeMouseEnter={handleEdgeMouseEnter}
        onEdgeMouseLeave={handleEdgeMouseLeave}
        onPaneClick={handlePaneClick}
        onMoveEnd={handleMoveEnd}
        nodeTypes={nodeTypes}
        onInit={setReactFlowInstance}
        fitView={!getViewport()}
        edgesReconnectable={true}
        edgesFocusable={true}
        connectionMode={ConnectionMode.Loose}
        connectOnClick={false}
        connectionRadius={30}
      >
        <Background 
          variant={BackgroundVariant.Dots} 
          gap={16} 
          size={1}
          className="bg-canvas"
        />
        <div className="react-flow-controls-wrapper">
          <Controls />
        </div>
        <MiniMap 
          className="!bg-card/95 backdrop-blur-sm !border-border !rounded-lg !shadow-lg"
          maskColor="hsl(var(--background) / 0.6)"
          nodeColor={(node) => {
            if (node.type === 'start') return 'hsl(var(--success))';
            if (node.type === 'end') return 'hsl(var(--destructive))';
            if (node.type === 'group') return 'hsl(260 60% 55%)';
            return 'hsl(var(--primary))';
          }}
          nodeStrokeWidth={2}
          pannable
          zoomable
        />
      </ReactFlow>

      {contextMenu && (
        <CanvasContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          canvasPosition={contextMenu.canvasPosition || { x: 0, y: 0 }}
          selectedNode={selectedNode}
          onClose={() => setContextMenu(null)}
          onConfigureNode={() => {
            setShowConfigPanel(true);
            setContextMenu(null);
          }}
        />
      )}

      {showConfigPanel && selectedNode && (
        <NodeConfigPanel
          node={selectedNode}
          onClose={() => {
            setShowConfigPanel(false);
            setSelectedNode(null);
          }}
        />
      )}

      <EdgeTypeDialog
        open={showEdgeTypeDialog}
        onSelect={handleEdgeTypeSelect}
        onCancel={handleEdgeTypeCancel}
      />
    </div>
  );
};

const TestCanvas = () => {
  return (
    <ReactFlowProvider>
      <TestCanvasContent />
    </ReactFlowProvider>
  );
};

export default TestCanvas;
