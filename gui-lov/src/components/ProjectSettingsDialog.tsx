import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Project } from "@/lib/api/types";
import { Plus, X } from "lucide-react";

interface VariableRow {
  name: string;
  value: string;
}

interface ProjectSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  onSave: (settings: Record<string, unknown>) => Promise<void>;
}

export const ProjectSettingsDialog = ({
  open,
  onOpenChange,
  project,
  onSave,
}: ProjectSettingsDialogProps) => {
  const [baseUrl, setBaseUrl] = useState("");
  const [variables, setVariables] = useState<VariableRow[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  // Initialize from project settings when dialog opens
  useEffect(() => {
    if (open && project) {
      setBaseUrl((project.settings?.baseUrl as string) || "");
      const vars = (project.settings?.variables as Record<string, string>) || {};
      setVariables(
        Object.entries(vars).map(([name, value]) => ({ name, value: String(value) }))
      );
    }
  }, [open, project]);

  const addVariable = () => setVariables(prev => [...prev, { name: "", value: "" }]);
  const removeVariable = (index: number) => setVariables(prev => prev.filter((_, i) => i !== index));
  const updateVariable = (index: number, field: "name" | "value", val: string) => {
    setVariables(prev => prev.map((v, i) => i === index ? { ...v, [field]: val } : v));
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Build variables object from rows
      const varsObj: Record<string, string> = {};
      for (const v of variables) {
        if (v.name.trim()) {
          varsObj[v.name.trim()] = v.value;
        }
      }

      await onSave({
        ...project.settings,
        baseUrl: baseUrl.trim() || undefined,
        variables: Object.keys(varsObj).length > 0 ? varsObj : undefined,
      });
      toast.success("Project settings saved");
      onOpenChange(false);
    } catch (error) {
      toast.error("Failed to save settings");
      console.error("Failed to save project settings:", error);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Project Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-6 py-4">
          {/* Base URL */}
          <div className="space-y-2">
            <Label htmlFor="base-url">Base URL</Label>
            <Input
              id="base-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://localhost:3000"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Prepended to relative test case endpoints (e.g., /api/users becomes http://localhost:3000/api/users)
            </p>
          </div>

          {/* Project Variables */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <Label>Project Variables</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Available as {"{{variableName}}"} in endpoints, headers, and payloads
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={addVariable} className="gap-1.5">
                <Plus className="w-3.5 h-3.5" />
                Add
              </Button>
            </div>

            {variables.length > 0 ? (
              <div className="space-y-2">
                {/* Header row */}
                <div className="grid grid-cols-[1fr_1fr_32px] gap-2 px-0.5">
                  <span className="text-xs font-medium text-muted-foreground">Name</span>
                  <span className="text-xs font-medium text-muted-foreground">Value</span>
                  <span />
                </div>
                {variables.map((v, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_32px] gap-2 items-center">
                    <Input
                      value={v.name}
                      onChange={(e) => updateVariable(i, "name", e.target.value)}
                      placeholder="variableName"
                      className="font-mono h-8 text-sm"
                    />
                    <Input
                      value={v.value}
                      onChange={(e) => updateVariable(i, "value", e.target.value)}
                      placeholder="value"
                      className="font-mono h-8 text-sm"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => removeVariable(i)}
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="border border-dashed rounded-md p-4 text-center">
                <p className="text-sm text-muted-foreground">
                  No variables defined. Click "Add" to create one.
                </p>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
