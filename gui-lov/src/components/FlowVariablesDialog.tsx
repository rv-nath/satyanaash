import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Plus, Trash2 } from "lucide-react";

interface VariableRow {
  key: string;
  value: string;
}

interface FlowVariablesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variables: Record<string, unknown>;
  onSave: (variables: Record<string, unknown>) => void;
}

export const FlowVariablesDialog = ({
  open,
  onOpenChange,
  variables,
  onSave,
}: FlowVariablesDialogProps) => {
  const [rows, setRows] = useState<VariableRow[]>([]);

  useEffect(() => {
    if (open) {
      const entries = Object.entries(variables || {}).map(([key, value]) => ({
        key,
        value: String(value ?? ""),
      }));
      setRows(entries.length > 0 ? entries : []);
    }
  }, [open, variables]);

  const addRow = () => {
    setRows([...rows, { key: "", value: "" }]);
  };

  const removeRow = (index: number) => {
    setRows(rows.filter((_, i) => i !== index));
  };

  const updateRow = (index: number, field: keyof VariableRow, value: string) => {
    const updated = [...rows];
    updated[index] = { ...updated[index], [field]: value };
    setRows(updated);
  };

  const handleSave = () => {
    const vars: Record<string, unknown> = {};
    for (const row of rows) {
      if (row.key.trim()) {
        vars[row.key.trim()] = row.value;
      }
    }
    onSave(vars);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Flow Variables</DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Variables scoped to this flow. Available in all nodes via{" "}
            <code className="px-1 py-0.5 bg-muted rounded text-xs">{"{{variableName}}"}</code> syntax.
            Overridden by node input variables and upstream exports.
          </p>
        </DialogHeader>

        <div className="space-y-2 max-h-80 overflow-y-auto py-2">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground italic text-center py-4">
              No flow variables defined
            </p>
          ) : (
            rows.map((row, i) => (
              <div key={i} className="flex gap-2 items-center">
                <Input
                  placeholder="Variable name"
                  value={row.key}
                  onChange={(e) => updateRow(i, "key", e.target.value)}
                  className="h-8 text-xs font-mono flex-1"
                />
                <Input
                  placeholder="Value"
                  value={row.value}
                  onChange={(e) => updateRow(i, "value", e.target.value)}
                  className="h-8 text-xs font-mono flex-1"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeRow(i)}
                  className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))
          )}
        </div>

        <Button variant="outline" size="sm" onClick={addRow} className="w-full">
          <Plus className="h-3 w-3 mr-1" />
          Add Variable
        </Button>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
