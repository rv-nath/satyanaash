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
      toast.error("Flow name is required");
      return;
    }

    onSubmit({ name, description });
    setName("");
    setDescription("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "Create Flow" : "Edit Flow"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="flow-name">Name</Label>
            <Input
              id="flow-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Authentication Flow"
              className="font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="flow-description">Description (optional)</Label>
            <Textarea
              id="flow-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of this flow..."
              rows={3}
            />
          </div>
          <Button onClick={handleSubmit} className="w-full">
            {mode === "create" ? "Create Flow" : "Save Changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
