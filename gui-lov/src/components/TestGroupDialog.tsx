import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface TestGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: { name: string; description?: string }) => void;
  initialData?: { name: string; description?: string };
  mode: "create" | "edit";
}

export const TestGroupDialog = ({ 
  open, 
  onOpenChange, 
  onSubmit, 
  initialData,
  mode 
}: TestGroupDialogProps) => {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (initialData) {
      setName(initialData.name);
      setDescription(initialData.description || "");
    } else {
      setName("");
      setDescription("");
    }
  }, [initialData, open]);

  const handleSubmit = () => {
    if (!name.trim()) {
      toast.error("Group name is required");
      return;
    }

    onSubmit({ name, description });
    setName("");
    setDescription("");
    onOpenChange(false);
    toast.success(mode === "create" ? "Test group created" : "Test group updated");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "Create Test Group" : "Edit Test Group"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="group-name">Group Name</Label>
            <Input
              id="group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Authentication Flow"
              className="font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="group-description">Description (optional)</Label>
            <Textarea
              id="group-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of this test group..."
              rows={3}
            />
          </div>
          <Button onClick={handleSubmit} className="w-full">
            {mode === "create" ? "Create Group" : "Save Changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
