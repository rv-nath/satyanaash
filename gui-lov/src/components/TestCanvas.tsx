import { useCallback, useState, useEffect, useRef, useMemo } from "react";
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
  ViewportPortal,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTestProject } from "@/contexts/TestProjectContext";
import { useTestCases } from "@/hooks/useApi";
import { TestCaseNode, StartNode, EndNode, GroupNode, AwaitCallbackNode } from "./CustomNodes";
import { CanvasContextMenu } from "./CanvasContextMenu";
import { NodeConfigPanel } from "./NodeConfigPanel";
import { cleanupBandFor } from "@/lib/cleanupBand";
import { canvasNodeName, completedCount, executionClassFor, flowExecutionView } from "@/lib/executionDecor";
import { droppedNode } from "@/lib/dropPayload";
import { StepControls } from "./StepControls";
import { EdgeTypeDialog } from "./EdgeTypeDialog";
import { getLayoutedElements, type LayoutDirection, type LayoutSpacing } from "@/lib/layoutUtils";
import { useReactFlow } from "@xyflow/react";
import { toast } from "sonner";

const nodeTypes = {
  testCase: TestCaseNode,
  start: StartNode,
  end: EndNode,
  group: GroupNode,
  awaitCallback: AwaitCallbackNode,
};

const TestCanvasContent = () => {
  const { nodes: contextNodes, edges: contextEdges, setNodes, setEdges, showEdgeLabels, edgeType, addNodeToCanvas, flows, deleteNodes, activeFlowId, undo, redo, snapToGrid, setViewport, getViewport, invalidNodeIds, validationErrors, layoutRequest, nodeRuns, inlinedByFlow, activeNodeId, pausedNodeId, runMode, totalNodes, step, executingFlowId, openTestTab, projectId } = useTestProject();
  const [nodes, setNodesState, onNodesChange] = useNodesState(contextNodes);
  // Cached by the nodes themselves already; used here only to spot a node pointing
  // at a test case that has since been deleted.
  const { data: testCases } = useTestCases(projectId || '');

  const cleanupBand = useMemo(() => cleanupBandFor(nodes), [nodes]);
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
  const totalTests = flows.reduce((sum, g) => sum + g.testCases.length, 0);
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
        // Snap only the nodes that actually moved. Re-snapping every node on any
        // change (even a selection) silently rewrote the precise positions set by
        // align / distribute / auto-arrange, undoing even spacing.
        const movedIds = new Set<string>(
          (changes ?? [])
            .filter((c: any) => c?.type === 'position' && c?.id)
            .map((c: any) => c.id as string)
        );
        const snappedNodes = snapToGrid && movedIds.size > 0
          ? currentNodes.map(node =>
              movedIds.has(node.id)
                ? {
                    ...node,
                    position: {
                      x: Math.round(node.position.x / 20) * 20,
                      y: Math.round(node.position.y / 20) * 20,
                    },
                  }
                : node
            )
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
      
      // No `animated` and no `style`: an edge drawn now must look exactly like the same
      // edge after a reload. Neither is persisted by `edgesToApi`, so setting them here
      // made a fresh edge a marching dashed line until the next load — a difference that
      // encoded nothing, and didn't even mean "unsaved" (autosave lands it seconds
      // later, still dashed). Colour and label are applied centrally from `data.type`.
      const newEdge = {
        ...pendingConnection,
        data: { type },
        label: type === 'success' ? 'Success' : 'Failure',
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

  const handleAutoLayout = useCallback((direction: LayoutDirection = 'TB', spacing: LayoutSpacing = 'comfortable') => {
    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(nodes, edges, direction, spacing);
    setNodesState(layoutedNodes);
    setNodes(layoutedNodes);
    setEdgesState(layoutedEdges);
    setEdges(layoutedEdges);

    // Fit view after layout with a small delay to ensure layout is applied
    setTimeout(() => {
      fitView({ padding: 0.2, duration: 400 });
    }, 50);
  }, [nodes, edges, setNodesState, setNodes, setEdgesState, setEdges, fitView]);

  // The toolbar lives outside ReactFlowProvider, so it raises a request and the
  // canvas (which owns fitView) performs the arrangement.
  const lastLayoutSeqRef = useRef(0);
  useEffect(() => {
    if (!layoutRequest || layoutRequest.seq === lastLayoutSeqRef.current) return;
    lastLayoutSeqRef.current = layoutRequest.seq;
    handleAutoLayout(layoutRequest.direction, layoutRequest.spacing);
    toast.success(layoutRequest.direction === 'TB' ? 'Arranged top to bottom' : 'Arranged left to right');
  }, [layoutRequest, handleAutoLayout]);

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

    const raw = event.dataTransfer.getData('application/json');
    const dropped = droppedNode(raw);
    if (!dropped) {
      // The payload, not just an error. This branch used to be a bare catch that logged the
      // exception alone, which is how a rail sending the wrong shape went unnoticed.
      console.warn('Ignored a drop the canvas could not read:', raw);
      return;
    }

    const position = reactFlowInstance.screenToFlowPosition({
      x: event.clientX,
      y: event.clientY,
    });
    addNodeToCanvas(dropped.type, dropped.data, position);
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
        // Everything selected goes, not just the last node clicked — now that a
        // multi-selection is visible, deleting one of three would be a surprise.
        const selectedIds = nodes.filter(n => n.selected).map(n => n.id);
        if (selectedIds.length > 0) {
          deleteNodes(selectedIds);
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
  }, [selectedNode, selectedEdge, deleteNodes, nodes, edges, setEdges, setEdgesState, undo, redo]);

  const handleNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setSelectedNode(node);
    setSelectedEdge(null);
    setShowConfigPanel(false);
  }, []);

  /**
   * Double-click a test node to open what it runs.
   *
   * The node shows a name and, through its ⓘ, a method and endpoint — the moment you
   * want more than that, you want the test case itself, and hunting for it in the
   * sidebar is a detour when you are already pointing at it.
   */
  const handleNodeDoubleClick = useCallback((_event: React.MouseEvent, node: Node) => {
    // A waiting step has no test case to open, so the natural gesture opens its config —
    // otherwise double-clicking it does nothing at all and reads as a dead node.
    if (node.type === 'awaitCallback') {
      setSelectedNode(node);
      setShowConfigPanel(true);
      return;
    }
    // Group nodes open their own editor, and start/end have nothing behind them.
    if (node.type !== 'testCase') return;
    const testCaseId = (node.data as { testCaseId?: string } | undefined)?.testCaseId;
    if (!testCaseId) {
      toast.error('This node has no test case attached');
      return;
    }
    // A node can outlive the test case it points at; validation flags the reference,
    // but say so here too rather than opening a tab that can never load.
    if (testCases && !testCases.some((tc: { id: string }) => tc.id === testCaseId)) {
      toast.error('That test case no longer exists');
      return;
    }
    openTestTab(testCaseId);
  }, [testCases, openTestTab]);

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

  // What the current or last run left on this flow's nodes. Only this flow's own
  // results decorate it — another flow's run is someone else's graph.
  const executionView = useMemo(
    () => flowExecutionView({ activeFlowId, executingFlowId, activeNodeId, pausedNodeId, nodeRuns, inlinedByFlow }),
    [executingFlowId, activeFlowId, activeNodeId, pausedNodeId, nodeRuns, inlinedByFlow],
  );

  // Apply node styling for selection, validation highlighting, and edge styling based on type
  const styledNodes = nodes.map(node => {
    const hasValidationIssue = invalidNodeIds.has(node.id);
    const isError = hasValidationIssue && validationErrors.some(e => e.node_id === node.id);
    const validationClass = hasValidationIssue
      ? (isError ? 'validation-error' : 'validation-warning')
      : '';

    return {
      ...node,
      // `selected` is React Flow's own, and it is left alone. Overwriting it with
      // "is this the last node clicked" un-selected every other member of a
      // multi-selection before it could be drawn — and told React Flow the same,
      // so dragging a selection moved one node out of it.
      // Execution comes last, so it wins over validation on equal specificity: while
      // a run is on screen, what just happened matters more than standing advice.
      className: [node.className, validationClass, executionClassFor(node.id, executionView)]
        .filter(Boolean).join(' '),
      style: {
        ...node.style,
        border: node.selected ? '2px solid hsl(var(--primary))' : undefined,
        boxShadow: node.selected ? '0 0 0 2px hsl(var(--primary) / 0.2)' : undefined,
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

  const activeFlow = flows.find(g => g.id === activeFlowId);

  return (
    <div 
      className="h-full w-full bg-canvas relative" 
      onContextMenu={handleContextMenu}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Controls for a run being driven a node at a time. Only shown for this
          flow's own run — stepping one flow while looking at another would offer
          buttons for a graph that isn't on screen. */}
      {executingFlowId === activeFlowId && (
        <StepControls
          mode={runMode}
          nextNodeName={pausedNodeId ? canvasNodeName(nodes, pausedNodeId) : null}
          done={completedCount(activeFlowId ? nodeRuns[activeFlowId] : undefined)}
          total={totalNodes}
          onStep={step}
        />
      )}

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
        /* A marquee drag starts a native text selection at the pane, and the browser extends
           it across every sibling in the document — so drag-selecting nodes painted the rail
           labels, the flow names and the tab title grey. Killing it at the origin is the fix.

           Safe for the things that must stay copyable: node popovers render through a Radix
           portal on <body>, so an exported JWT is still selectable. */
        className="select-none"
        nodes={styledNodes}
        edges={styledEdges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        onReconnect={onReconnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
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
        {/* A tinted region around the nodes marked "at the end", so that running
            after the flow reads spatially and not only from a chip. Drawn *behind*
            the nodes and it never moves them: the band follows wherever they were
            placed, rather than the author's layout being rewritten to suit it. */}
        {cleanupBand && (
          <ViewportPortal>
            <div
              style={{
                position: "absolute",
                left: cleanupBand.x,
                top: cleanupBand.y,
                width: cleanupBand.width,
                height: cleanupBand.height,
                pointerEvents: "none",
                zIndex: -1,
              }}
              className="rounded-2xl border border-dashed border-muted-foreground/40 bg-muted/40"
            >
              <span className="absolute left-3 top-2 select-none text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Cleanup · runs after the flow
              </span>
            </div>
          </ViewportPortal>
        )}

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
