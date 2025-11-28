import { useState, useEffect } from "react";
import { Node, Edge } from "@xyflow/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertCircle, AlertTriangle, CheckCircle2, X } from "lucide-react";
import { extractVariables, getAllUsedVariables, getAllOutputVariables } from "@/lib/variableUtils";

export interface ValidationIssue {
  type: 'error' | 'warning';
  category: 'variable' | 'topology' | 'flow';
  nodeId?: string;
  message: string;
}

interface FlowValidatorProps {
  nodes: Node[];
  edges: Edge[];
  testGroups: any[];
  onClose: () => void;
  onJumpToNode?: (nodeId: string) => void;
}

export const FlowValidator = ({ nodes, edges, testGroups, onClose, onJumpToNode }: FlowValidatorProps) => {
  const [issues, setIssues] = useState<ValidationIssue[]>([]);

  useEffect(() => {
    validateFlow();
  }, [nodes, edges]);

  const validateFlow = () => {
    const newIssues: ValidationIssue[] = [];

    // 1. Check for undefined variables
    const allOutputVars = getAllOutputVariables(nodes);
    const outputVarNames = new Set(allOutputVars.map(v => v.name));

    nodes.forEach(node => {
      if (node.type === 'start' || node.type === 'end') return;

      const testCase = node.data as any;
      const usedVars = getAllUsedVariables({
        endpoint: testCase.endpoint as string | undefined,
        payload: testCase.payload as string | undefined,
        preTestScript: testCase.preTestScript as string | undefined,
        postTestScript: testCase.postTestScript as string | undefined,
      });

      usedVars.forEach(varName => {
        if (!outputVarNames.has(varName)) {
          newIssues.push({
            type: 'error',
            category: 'variable',
            nodeId: node.id,
            message: `Variable "{{${varName}}}" is used but never defined in any upstream node`,
          });
        }
      });
    });

    // 2. Check for start/end nodes
    const startNodes = nodes.filter(n => n.type === 'start');
    const endNodes = nodes.filter(n => n.type === 'end');

    if (startNodes.length === 0) {
      newIssues.push({
        type: 'error',
        category: 'topology',
        message: 'Flow must have exactly one Start node',
      });
    } else if (startNodes.length > 1) {
      newIssues.push({
        type: 'error',
        category: 'topology',
        message: `Flow has ${startNodes.length} Start nodes, should have exactly one`,
      });
    }

    if (endNodes.length === 0) {
      newIssues.push({
        type: 'error',
        category: 'topology',
        message: 'Flow must have exactly one End node',
      });
    } else if (endNodes.length > 1) {
      newIssues.push({
        type: 'error',
        category: 'topology',
        message: `Flow has ${endNodes.length} End nodes, should have exactly one`,
      });
    }

    // 3. Check for orphan nodes (no incoming or outgoing edges)
    nodes.forEach(node => {
      if (node.type === 'start' || node.type === 'end') return;

      const hasIncoming = edges.some(e => e.target === node.id);
      const hasOutgoing = edges.some(e => e.source === node.id);

      if (!hasIncoming && !hasOutgoing) {
        newIssues.push({
          type: 'warning',
          category: 'topology',
          nodeId: node.id,
          message: `Node "${node.data.label || node.id}" is orphaned (no connections)`,
        });
      } else if (!hasIncoming && node.type !== 'start') {
        newIssues.push({
          type: 'warning',
          category: 'flow',
          nodeId: node.id,
          message: `Node "${node.data.label || node.id}" has no incoming connections`,
        });
      }
    });

    // 4. Check for unreachable nodes (not connected to start)
    if (startNodes.length === 1) {
      const reachableNodes = findReachableNodes(startNodes[0].id, edges);
      nodes.forEach(node => {
        if (node.type !== 'start' && !reachableNodes.has(node.id)) {
          newIssues.push({
            type: 'warning',
            category: 'flow',
            nodeId: node.id,
            message: `Node "${node.data.label || node.id}" is unreachable from Start node`,
          });
        }
      });
    }

    // 5. Check for cyclic dependencies
    const cycles = detectCycles(nodes, edges);
    if (cycles.length > 0) {
      newIssues.push({
        type: 'error',
        category: 'flow',
        message: `Detected ${cycles.length} cycle(s) in the flow. Cycles can cause infinite loops.`,
      });
    }

    setIssues(newIssues);
  };

  const findReachableNodes = (startNodeId: string, edges: Edge[]): Set<string> => {
    const reachable = new Set<string>();
    const visited = new Set<string>();

    const traverse = (nodeId: string) => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      reachable.add(nodeId);

      edges.forEach(edge => {
        if (edge.source === nodeId) {
          traverse(edge.target);
        }
      });
    };

    traverse(startNodeId);
    return reachable;
  };

  const detectCycles = (nodes: Node[], edges: Edge[]): string[][] => {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recStack = new Set<string>();
    const path: string[] = [];

    const dfs = (nodeId: string): boolean => {
      visited.add(nodeId);
      recStack.add(nodeId);
      path.push(nodeId);

      const outgoingEdges = edges.filter(e => e.source === nodeId);
      for (const edge of outgoingEdges) {
        if (!visited.has(edge.target)) {
          if (dfs(edge.target)) return true;
        } else if (recStack.has(edge.target)) {
          // Cycle detected
          const cycleStart = path.indexOf(edge.target);
          cycles.push([...path.slice(cycleStart), edge.target]);
          return true;
        }
      }

      path.pop();
      recStack.delete(nodeId);
      return false;
    };

    nodes.forEach(node => {
      if (!visited.has(node.id)) {
        dfs(node.id);
      }
    });

    return cycles;
  };

  const errorCount = issues.filter(i => i.type === 'error').length;
  const warningCount = issues.filter(i => i.type === 'warning').length;

  return (
    <Card className="absolute top-4 right-4 w-96 max-h-[calc(100vh-120px)] z-50 shadow-lg border-border bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <CardTitle className="text-lg flex items-center gap-2">
              Validation Results
              {issues.length === 0 ? (
                <CheckCircle2 className="h-5 w-5 text-success" />
              ) : errorCount > 0 ? (
                <AlertCircle className="h-5 w-5 text-destructive" />
              ) : (
                <AlertTriangle className="h-5 w-5 text-warning" />
              )}
            </CardTitle>
            <CardDescription className="text-sm mt-1">
              {issues.length === 0 ? (
                "No issues found"
              ) : (
                <div className="flex gap-2 mt-1">
                  {errorCount > 0 && <Badge variant="destructive">{errorCount} Error{errorCount !== 1 ? 's' : ''}</Badge>}
                  {warningCount > 0 && <Badge variant="outline" className="border-warning text-warning">{warningCount} Warning{warningCount !== 1 ? 's' : ''}</Badge>}
                </div>
              )}
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[calc(100vh-240px)]">
          <div className="px-4 pb-4 space-y-2">
            {issues.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <CheckCircle2 className="h-12 w-12 mx-auto mb-2 text-success" />
                <p className="text-sm">All checks passed!</p>
                <p className="text-xs mt-1">Your flow is ready to export.</p>
              </div>
            ) : (
              issues.map((issue, idx) => (
                <div
                  key={idx}
                  className={`p-3 rounded-md border ${
                    issue.type === 'error' 
                      ? 'bg-destructive/10 border-destructive/30' 
                      : 'bg-warning/10 border-warning/30'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {issue.type === 'error' ? (
                      <AlertCircle className="h-4 w-4 text-destructive mt-0.5 flex-shrink-0" />
                    ) : (
                      <AlertTriangle className="h-4 w-4 text-warning mt-0.5 flex-shrink-0" />
                    )}
                    <div className="flex-1 space-y-1">
                      <p className="text-xs leading-relaxed">{issue.message}</p>
                      <div className="flex gap-2">
                        <Badge variant="outline" className="text-xs h-5">
                          {issue.category}
                        </Badge>
                        {issue.nodeId && onJumpToNode && (
                          <Button
                            variant="link"
                            size="sm"
                            className="h-5 px-0 text-xs"
                            onClick={() => onJumpToNode(issue.nodeId!)}
                          >
                            Jump to node →
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
        
        <div className="p-4 border-t border-border bg-muted/20 flex justify-end">
          <Button variant="outline" size="sm" onClick={validateFlow}>
            Re-validate
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

export const getValidationStatus = (nodes: Node[], edges: Edge[]) => {
  // Quick validation check without full details
  const hasStart = nodes.some(n => n.type === 'start');
  const hasEnd = nodes.some(n => n.type === 'end');
  
  if (!hasStart || !hasEnd) {
    return { status: 'error' as const, message: 'Missing start or end node' };
  }

  const orphanNodes = nodes.filter(n => {
    if (n.type === 'start' || n.type === 'end') return false;
    const hasIncoming = edges.some(e => e.target === n.id);
    const hasOutgoing = edges.some(e => e.source === n.id);
    return !hasIncoming && !hasOutgoing;
  });

  if (orphanNodes.length > 0) {
    return { status: 'warning' as const, message: `${orphanNodes.length} orphan node(s)` };
  }

  return { status: 'valid' as const, message: 'Flow is valid' };
};
