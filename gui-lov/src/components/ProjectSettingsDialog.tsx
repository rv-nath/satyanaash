import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Project } from "@/lib/api/types";
import { Plus, X, Trash2 } from "lucide-react";
import { readGlobals, readEnvironments, genEnvId } from "@/lib/environments";

interface VariableRow {
  name: string;
  value: string;
}

interface EnvDraft {
  id: string;
  name: string;
  rows: VariableRow[];
}

interface ProjectSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  onSave: (settings: Record<string, unknown>) => Promise<void>;
}

const objToRows = (obj: Record<string, string>): VariableRow[] =>
  Object.entries(obj).map(([name, value]) => ({ name, value: String(value) }));

const rowsToObj = (rows: VariableRow[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const r of rows) if (r.name.trim()) out[r.name.trim()] = r.value;
  return out;
};

/** Editable name/value table shared by Globals and each environment. */
const VarRows = ({ rows, onChange }: { rows: VariableRow[]; onChange: (rows: VariableRow[]) => void }) => {
  const add = () => onChange([...rows, { name: "", value: "" }]);
  const remove = (i: number) => onChange(rows.filter((_, x) => x !== i));
  const update = (i: number, field: "name" | "value", val: string) =>
    onChange(rows.map((r, x) => (x === i ? { ...r, [field]: val } : r)));

  return (
    <div className="space-y-2">
      {rows.length > 0 && (
        <>
          <div className="grid grid-cols-[1fr_1fr_32px] gap-2 px-0.5">
            <span className="text-xs font-medium text-muted-foreground">Name</span>
            <span className="text-xs font-medium text-muted-foreground">Value</span>
            <span />
          </div>
          {rows.map((v, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_32px] gap-2 items-center">
              <Input
                value={v.name}
                onChange={(e) => update(i, "name", e.target.value)}
                placeholder="variableName"
                className="font-mono h-8 text-sm"
              />
              <Input
                value={v.value}
                onChange={(e) => update(i, "value", e.target.value)}
                placeholder="value"
                className="font-mono h-8 text-sm"
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                onClick={() => remove(i)}
              >
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
        </>
      )}
      <Button variant="outline" size="sm" onClick={add} className="gap-1.5">
        <Plus className="w-3.5 h-3.5" />
        Add variable
      </Button>
    </div>
  );
};

export const ProjectSettingsDialog = ({ open, onOpenChange, project, onSave }: ProjectSettingsDialogProps) => {
  const [globals, setGlobals] = useState<VariableRow[]>([]);
  const [environments, setEnvironments] = useState<EnvDraft[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (open && project) {
      setGlobals(objToRows(readGlobals(project.settings)));
      setEnvironments(
        readEnvironments(project.settings).map((e) => ({ id: e.id, name: e.name, rows: objToRows(e.variables) }))
      );
    }
  }, [open, project]);

  const addEnv = () =>
    setEnvironments((prev) => [...prev, { id: genEnvId(), name: `env-${prev.length + 1}`, rows: [] }]);
  const removeEnv = (id: string) => setEnvironments((prev) => prev.filter((e) => e.id !== id));
  const renameEnv = (id: string, name: string) =>
    setEnvironments((prev) => prev.map((e) => (e.id === id ? { ...e, name } : e)));
  const setEnvRows = (id: string, rows: VariableRow[]) =>
    setEnvironments((prev) => prev.map((e) => (e.id === id ? { ...e, rows } : e)));

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const globalsObj = rowsToObj(globals);

      // Retire the old Base URL field: migrate its value into Globals as baseUrl.
      const legacyBaseUrl = (project.settings?.baseUrl as string) || "";
      if (legacyBaseUrl && !globalsObj.baseUrl) globalsObj.baseUrl = legacyBaseUrl;

      const envs = environments
        .filter((e) => e.name.trim())
        .map((e) => ({ id: e.id, name: e.name.trim(), variables: rowsToObj(e.rows) }));

      const newSettings: Record<string, unknown> = { ...(project.settings || {}) };
      delete newSettings.baseUrl; // retired
      newSettings.variables = Object.keys(globalsObj).length > 0 ? globalsObj : undefined;
      newSettings.environments = envs.length > 0 ? envs : undefined;

      await onSave(newSettings);
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
      <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Project Settings</DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-2 overflow-y-auto pr-1">
          {/* Globals */}
          <div className="space-y-3">
            <div>
              <Label>Globals</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Shared variables, available as {"{{variableName}}"} in every environment. Put things like{" "}
                <code className="px-1 py-0.5 bg-muted rounded">baseUrl</code> here (or override per environment below).
              </p>
            </div>
            <VarRows rows={globals} onChange={setGlobals} />
          </div>

          {/* Environments */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <Label>Environments</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Switchable var sets (dev / staging / prod). An environment value overrides a global of the same name.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={addEnv} className="gap-1.5">
                <Plus className="w-3.5 h-3.5" />
                Add environment
              </Button>
            </div>

            {environments.length === 0 ? (
              <div className="border border-dashed rounded-md p-4 text-center">
                <p className="text-sm text-muted-foreground">
                  No environments yet. Add one to switch base URLs / credentials per stage.
                </p>
              </div>
            ) : (
              environments.map((env) => (
                <div key={env.id} className="border border-border rounded-md p-3 space-y-3 bg-muted/20">
                  <div className="flex items-center gap-2">
                    <Input
                      value={env.name}
                      onChange={(e) => renameEnv(env.id, e.target.value)}
                      placeholder="environment name"
                      className="h-8 text-sm font-medium"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive shrink-0"
                      onClick={() => removeEnv(env.id)}
                      title="Delete environment"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  <VarRows rows={env.rows} onChange={(rows) => setEnvRows(env.id, rows)} />
                </div>
              ))
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
