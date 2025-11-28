import React, { useCallback } from 'react';
import ReactFlow, {
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type OnConnect,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { ArrowLeft, Save, Play, Download } from 'lucide-react';
import { useParams, useNavigate } from '@tanstack/react-router';
import { Button } from '../components/ui/Button';
import { useProject } from '../hooks/useProjects';

const initialNodes: Node[] = [
  {
    id: 'entry',
    type: 'input',
    data: { label: 'Entry' },
    position: { x: 250, y: 0 },
    style: { background: '#14b8a6', color: 'white', padding: 10, borderRadius: 8 },
  },
  {
    id: 'test-1',
    data: { label: '🧪 Login Test\nPOST /api/login' },
    position: { x: 250, y: 100 },
    style: { background: '#3b82f6', color: 'white', padding: 15, borderRadius: 8, minWidth: 200 },
  },
  {
    id: 'test-2',
    data: { label: '🧪 Get User\nGET /api/user' },
    position: { x: 250, y: 220 },
    style: { background: '#3b82f6', color: 'white', padding: 15, borderRadius: 8, minWidth: 200 },
  },
  {
    id: 'exit',
    type: 'output',
    data: { label: 'Exit' },
    position: { x: 250, y: 340 },
    style: { background: '#ef4444', color: 'white', padding: 10, borderRadius: 8 },
  },
];

const initialEdges: Edge[] = [
  { id: 'e1', source: 'entry', target: 'test-1', animated: true },
  { id: 'e2', source: 'test-1', target: 'test-2', animated: true, label: 'success' },
  { id: 'e3', source: 'test-2', target: 'exit', animated: true },
];

export function GraphEditor() {
  const { projectId } = useParams({ from: '/projects/$projectId/editor' });
  const navigate = useNavigate();
  const { data: project, isLoading } = useProject(projectId);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const onConnect: OnConnect = useCallback(
    (params) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  );

  const handleBack = () => {
    navigate({ to: '/' });
  };

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-neutral-500">Loading project...</div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-neutral-500">Project not found</div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col">
      {/* Toolbar */}
      <div className="h-14 bg-white border-b border-neutral-200 flex items-center justify-between px-4">
        <div className="flex items-center gap-4">
          <button
            onClick={handleBack}
            className="flex items-center gap-2 text-neutral-600 hover:text-neutral-900"
          >
            <ArrowLeft className="w-5 h-5" />
            <span className="font-medium">{project.name}</span>
          </button>
          <div className="h-6 w-px bg-neutral-200" />
          <span className="text-sm text-neutral-500">Version 1</span>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm">
            <Download className="w-4 h-4 mr-2" />
            Export
          </Button>
          <Button variant="secondary" size="sm">
            <Save className="w-4 h-4 mr-2" />
            Save
          </Button>
          <Button size="sm">
            <Play className="w-4 h-4 mr-2" />
            Run
          </Button>
        </div>
      </div>

      {/* Graph Canvas */}
      <div className="flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          fitView
          snapToGrid={true}
          snapGrid={[20, 20]}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <Controls />
          <MiniMap
            style={{
              height: 120,
            }}
            zoomable
            pannable
          />
        </ReactFlow>
      </div>
    </div>
  );
}
