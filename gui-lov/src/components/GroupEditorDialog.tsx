import { useState, useCallback, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  ReactFlow,
  Background,
  Controls,
  Connection,
  addEdge,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  ReactFlowProvider,
  Node,
  Edge,
} from "@xyflow/react";
import { TestCaseNode } from "./TestCaseNode";
import { StartNode } from "./StartNode";
import { EndNode } from "./EndNode";
import { useTestProject } from "@/contexts/TestProjectContext";
import { Button } from "@/components/ui/button";

const nodeTypes = {
  testCase: TestCaseNode,
  start: StartNode,
  end: EndNode,
};

interface GroupEditorDialogProps {
  groupId: string;
  groupName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const GroupEditorContent = ({ groupId, groupName, onOpenChange }: Omit<GroupEditorDialogProps, 'open'>) => {
  const { testGroups, updateGroupFlow } = useTestProject();
  const group = testGroups.find(g => g.id === groupId);
  
  const initialNodes: Node[] = group?.internalNodes || [
    {
      id: "start-internal",
      type: "start",
      position: { x: 250, y: 50 },
      data: { label: "Start" },
    },
    ...(group?.testCases.map((tc, idx) => ({
      id: tc.id,
      type: "testCase" as const,
      position: { x: 250, y: 150 + idx * 120 },
      data: {
        label: tc.name,
        method: tc.method,
        endpoint: tc.endpoint,
      },
    })) || []),
    {
      id: "end-internal",
      type: "end",
      position: { x: 250, y: 150 + (group?.testCases.length || 0) * 120 + 80 },
      data: { label: "End" },
    },
  ];

  const initialEdges: Edge[] = group?.internalEdges || [];

  const [nodes, setNodesState, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdgesState, onEdgesChange] = useEdgesState(initialEdges);
  const [reactFlowInstance, setReactFlowInstance] = useState<any>(null);

  useEffect(() => {
    if (group?.internalNodes) {
      setNodesState(group.internalNodes);
    }
    if (group?.internalEdges) {
      setEdgesState(group.internalEdges);
    }
  }, [group?.internalNodes, group?.internalEdges, setNodesState, setEdgesState]);

  const onConnect = useCallback(
    (connection: Connection) => {
      const newEdge = {
        ...connection,
        animated: true,
        data: { type: 'success' },
        label: 'Success',
        style: { stroke: 'hsl(var(--success))' },
      };
      setEdgesState((eds) => addEdge(newEdge, eds));
    },
    [setEdgesState]
  );

  const handleSave = () => {
    updateGroupFlow(groupId, nodes, edges);
    onOpenChange(false);
  };

  return (
    <div className="h-[600px] w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        onInit={setReactFlowInstance}
        fitView
      >
        <Background 
          variant={BackgroundVariant.Dots} 
          gap={16} 
          size={1}
          className="bg-muted/20"
        />
        <Controls className="bg-card border border-border" />
      </ReactFlow>
      
      <div className="absolute bottom-4 right-4 z-10 flex gap-2">
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button onClick={handleSave}>
          Save Flow
        </Button>
      </div>
    </div>
  );
};

export const GroupEditorDialog = ({ groupId, groupName, open, onOpenChange }: GroupEditorDialogProps) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl h-[700px] p-0">
        <DialogHeader className="p-6 pb-0">
          <DialogTitle>Edit Flow: {groupName}</DialogTitle>
          <DialogDescription>
            Arrange and connect test cases to define the execution flow within this group.
          </DialogDescription>
        </DialogHeader>
        <div className="p-6 pt-4 h-full">
          <ReactFlowProvider>
            <GroupEditorContent 
              groupId={groupId} 
              groupName={groupName} 
              onOpenChange={onOpenChange}
            />
          </ReactFlowProvider>
        </div>
      </DialogContent>
    </Dialog>
  );
};
