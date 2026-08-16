import { useTestProject } from "@/contexts/TestProjectContext";
import { Plus, FolderTree, PlayCircle, CheckCircle } from "lucide-react";

interface CanvasContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  canvasPosition: { x: number; y: number };
  selectedNode: any | null;
  onConfigureNode: () => void;
}

export const CanvasContextMenu = ({ x, y, onClose, canvasPosition, selectedNode, onConfigureNode }: CanvasContextMenuProps) => {
  const { flows, addNodeToCanvas, activeFlowId } = useTestProject();

  // Filter out the current flow - can't add a flow into itself (prevents recursion)
  const availableFlows = flows.filter(g => g.id !== activeFlowId);

  const handleAddNode = (type: 'start' | 'end', label: string) => {
    addNodeToCanvas(type, { label }, canvasPosition);
    onClose();
  };

  const handleAddGroup = (group: any) => {
    addNodeToCanvas('group', {
      label: group.name,
      flowId: group.id,  // Backend expects flowId for circular dependency validation
    }, canvasPosition);
    onClose();
  };

  const handleAddTestCase = (testCase: any) => {
    addNodeToCanvas('testCase', {
      label: testCase.name,
      method: testCase.method,
      endpoint: testCase.endpoint,
    }, canvasPosition);
    onClose();
  };

  return (
    <>
      <div 
        className="fixed inset-0 z-40" 
        onClick={onClose}
      />
      <div
        className="fixed z-50 bg-card border border-border rounded-lg shadow-lg py-1 min-w-[200px]"
        style={{ left: x, top: y }}
      >
        {selectedNode && selectedNode.type !== 'start' && selectedNode.type !== 'end' && (
          <>
            <button
              onClick={onConfigureNode}
              className="w-full px-3 py-2 text-left text-sm hover:bg-muted/50 transition-colors font-medium"
            >
              Configure Node
            </button>
            <div className="border-t border-border/50 my-1" />
          </>
        )}
        
        <div className="px-3 py-1.5 text-xs text-muted-foreground font-medium">
          Add Node
        </div>
        
        <button
          onClick={() => handleAddNode('start', 'Start')}
          className="w-full px-3 py-2 text-left text-sm hover:bg-muted/50 transition-colors flex items-center gap-2"
        >
          <PlayCircle className="w-3 h-3 text-success" />
          <span>Start Node</span>
        </button>

        <button
          onClick={() => handleAddNode('end', 'End')}
          className="w-full px-3 py-2 text-left text-sm hover:bg-muted/50 transition-colors flex items-center gap-2"
        >
          <CheckCircle className="w-3 h-3 text-primary" />
          <span>End Node</span>
        </button>

        <div className="px-3 py-1.5 text-xs text-muted-foreground font-medium border-t border-border/50 mt-1">
          Add Test Entities
        </div>
        
        {availableFlows.map((group) => (
          <div key={group.id}>
            <button
              onClick={() => handleAddGroup(group)}
              className="w-full px-3 py-2 text-left text-sm hover:bg-muted/50 transition-colors flex items-center gap-2 border-t border-border/50"
            >
              <FolderTree className="w-3 h-3 text-node-group" />
              <span className="font-medium">{group.name}</span>
              <span className="text-xs text-muted-foreground ml-auto">Group</span>
            </button>
            {group.testCases.map((testCase) => (
              <button
                key={testCase.id}
                onClick={() => handleAddTestCase(testCase)}
                className="w-full px-3 py-2 text-left text-sm hover:bg-muted/50 transition-colors flex items-center gap-2 pl-6"
              >
                <Plus className="w-3 h-3 text-primary" />
                <span className="font-mono text-xs truncate">{testCase.name}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  );
};
