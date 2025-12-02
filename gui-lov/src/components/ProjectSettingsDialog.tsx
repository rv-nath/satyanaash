import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Project } from "@/lib/api/types";

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
  const [isSaving, setIsSaving] = useState(false);

  // Initialize from project settings when dialog opens
  useEffect(() => {
    if (open && project) {
      setBaseUrl((project.settings?.baseUrl as string) || "");
    }
  }, [open, project]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave({
        ...project.settings,
        baseUrl: baseUrl.trim() || undefined, // Remove if empty
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Project Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
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
