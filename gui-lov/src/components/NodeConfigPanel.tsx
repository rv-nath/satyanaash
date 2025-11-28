import { useState, useEffect } from "react";
import { Node } from "@xyflow/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2, Plus } from "lucide-react";
import { useTestProject } from "@/contexts/TestProjectContext";

interface OutputVariable {
  name: string;
  path: string; // JSON path like "response.data.token"
  description?: string;
}

interface NodeConfigPanelProps {
  node: Node | null;
  onClose: () => void;
}

export const NodeConfigPanel = ({ node, onClose }: NodeConfigPanelProps) => {
  const { updateNodeConfig } = useTestProject();
  const [outputVars, setOutputVars] = useState<OutputVariable[]>([]);

  useEffect(() => {
    if (node?.data?.config) {
      const config = node.data.config as { outputVars?: OutputVariable[] };
      setOutputVars(config.outputVars || []);
    } else {
      setOutputVars([]);
    }
  }, [node]);

  const addOutputVar = () => {
    setOutputVars([...outputVars, { name: "", path: "", description: "" }]);
  };

  const removeOutputVar = (index: number) => {
    setOutputVars(outputVars.filter((_, i) => i !== index));
  };

  const updateOutputVar = (index: number, field: keyof OutputVariable, value: string) => {
    const updated = [...outputVars];
    updated[index] = { ...updated[index], [field]: value };
    setOutputVars(updated);
  };

  const handleSave = () => {
    if (!node) return;
    updateNodeConfig(node.id, { outputVars });
    onClose();
  };

  if (!node || node.type === 'start' || node.type === 'end') {
    return null;
  }

  return (
    <Card className="absolute top-4 right-4 w-96 max-h-[calc(100vh-120px)] z-50 shadow-lg border-border bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <CardTitle className="text-lg">Configure Node</CardTitle>
            <CardDescription className="text-sm mt-1">
              {(node.data.label as string) || node.id}
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            ✕
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[calc(100vh-240px)]">
          <div className="px-6 pb-4 space-y-6">
            <div className="bg-muted/50 border border-border rounded-md p-3 mb-4">
              <p className="text-xs text-muted-foreground">
                Define output variables that will be extracted from the HTTP response and made available to downstream nodes. 
                Use <code className="px-1 py-0.5 bg-background rounded text-xs">{'{{variableName}}'}</code> syntax in test cases to use these variables.
              </p>
            </div>

            {/* Output Variables */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <div>
                  <Label className="text-sm font-semibold">Output Variables</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Variables extracted from HTTP response
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={addOutputVar}>
                  <Plus className="h-3 w-3 mr-1" />
                  Add Variable
                </Button>
              </div>
              <div className="space-y-2">
                {outputVars.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">No output variables defined</p>
                ) : (
                  outputVars.map((v, i) => (
                    <div key={i} className="flex gap-2 items-start p-3 border border-border rounded-md bg-muted/20">
                      <div className="flex-1 space-y-2">
                        <Input
                          placeholder="Variable name (e.g., userId, authToken)"
                          value={v.name}
                          onChange={(e) => updateOutputVar(i, "name", e.target.value)}
                          className="h-8 text-xs font-mono"
                        />
                        <Input
                          placeholder="JSON path (e.g., response.data.token or response.user.id)"
                          value={v.path}
                          onChange={(e) => updateOutputVar(i, "path", e.target.value)}
                          className="h-8 text-xs font-mono"
                        />
                        <Input
                          placeholder="Description (optional)"
                          value={v.description || ""}
                          onChange={(e) => updateOutputVar(i, "description", e.target.value)}
                          className="h-8 text-xs"
                        />
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeOutputVar(i)}
                        className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </ScrollArea>
        
        <div className="p-4 border-t border-border bg-muted/20 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave}>
            Save Configuration
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
