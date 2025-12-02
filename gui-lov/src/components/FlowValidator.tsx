import { useState, useEffect, useCallback } from "react";
import { Node, Edge } from "@xyflow/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertCircle, AlertTriangle, CheckCircle2, X, Loader2 } from "lucide-react";
import { useValidateFlow } from "@/hooks/useApi";
import { ValidationIssue as ApiValidationIssue } from "@/lib/api/types";
import { nodesToApi, edgesToApi } from "@/lib/graphUtils";

export interface ValidationIssue {
  type: 'error' | 'warning';
  code: string;
  nodeId?: string;
  message: string;
}

interface FlowValidatorProps {
  nodes: Node[];
  edges: Edge[];
  testGroups: any[];
  activeFlowId: string | null;
  onClose: () => void;
  onJumpToNode?: (nodeId: string) => void;
}

export const FlowValidator = ({ nodes, edges, testGroups, activeFlowId, onClose, onJumpToNode }: FlowValidatorProps) => {
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [isValidating, setIsValidating] = useState(false);
  const validateFlowMutation = useValidateFlow();

  const validateFlow = useCallback(async () => {
    if (!activeFlowId) {
      setIssues([{
        type: 'error',
        code: 'NO_FLOW',
        message: 'No flow selected for validation',
      }]);
      return;
    }

    setIsValidating(true);
    try {
      // Send current canvas state to backend for validation
      const result = await validateFlowMutation.mutateAsync({
        id: activeFlowId,
        data: {
          nodes: nodesToApi(nodes),
          edges: edgesToApi(edges),
        },
      });

      // Combine errors and warnings from backend response
      const allIssues = [...(result.errors || []), ...(result.warnings || [])];

      // Map backend issues to frontend format
      const mappedIssues: ValidationIssue[] = allIssues.map((issue: ApiValidationIssue) => ({
        type: issue.severity,
        code: issue.code,
        nodeId: issue.node_id,
        message: issue.message,
      }));

      setIssues(mappedIssues);
    } catch (error) {
      setIssues([{
        type: 'error',
        code: 'API_ERROR',
        message: `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }]);
    } finally {
      setIsValidating(false);
    }
  }, [activeFlowId, nodes, edges, validateFlowMutation]);

  useEffect(() => {
    validateFlow();
  }, []);

  const errorCount = issues.filter(i => i.type === 'error').length;
  const warningCount = issues.filter(i => i.type === 'warning').length;

  return (
    <Card className="absolute top-4 right-4 w-96 max-h-[calc(100vh-120px)] z-50 shadow-lg border-border bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <CardTitle className="text-lg flex items-center gap-2">
              Validation Results
              {isValidating ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : issues.length === 0 ? (
                <CheckCircle2 className="h-5 w-5 text-success" />
              ) : errorCount > 0 ? (
                <AlertCircle className="h-5 w-5 text-destructive" />
              ) : (
                <AlertTriangle className="h-5 w-5 text-warning" />
              )}
            </CardTitle>
            <CardDescription className="text-sm mt-1">
              {isValidating ? (
                "Validating flow..."
              ) : issues.length === 0 ? (
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
            {isValidating ? (
              <div className="text-center py-8 text-muted-foreground">
                <Loader2 className="h-12 w-12 mx-auto mb-2 animate-spin" />
                <p className="text-sm">Validating flow...</p>
              </div>
            ) : issues.length === 0 ? (
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
                          {issue.code}
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
          <Button variant="outline" size="sm" onClick={validateFlow} disabled={isValidating}>
            {isValidating ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                Validating...
              </>
            ) : (
              'Re-validate'
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

