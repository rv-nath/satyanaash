import { useState, useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Plus, X, Trash2, Copy, Pencil, Braces, Layers, Info } from "lucide-react";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { Project } from "@/lib/api/types";
import { readGlobals, readEnvironments, genEnvId } from "@/lib/environments";
import { useUpdateProject } from "@/hooks/useApi";

interface VariableRow {
  name: string;
  value: string;
}
interface EnvDraft {
  id: string;
  name: string;
  rows: VariableRow[];
}

const objToRows = (obj: Record<string, string>): VariableRow[] =>
  Object.entries(obj).map(([name, value]) => ({ name, value: String(value) }));

const rowsToObj = (rows: VariableRow[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const r of rows) if (r.name.trim()) out[r.name.trim()] = r.value;
  return out;
};

/** Editable name/value table — the only thing on the right pane. */
const VarRows = ({ rows, onChange }: { rows: VariableRow[]; onChange: (rows: VariableRow[]) => void }) => {
  const nameRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  useEffect(() => {
    if (focusIdx !== null) {
      nameRefs.current[focusIdx]?.focus();
      setFocusIdx(null);
    }
  }, [focusIdx]);

  const add = () => {
    onChange([...rows, { name: "", value: "" }]);
    setFocusIdx(rows.length); // focus the new row's Name input
  };
  const remove = (i: number) => onChange(rows.filter((_, x) => x !== i));
  const update = (i: number, field: "name" | "value", val: string) =>
    onChange(rows.map((r, x) => (x === i ? { ...r, [field]: val } : r)));

  return (
    <div className="space-y-2 max-w-2xl">
      {rows.length > 0 && (
        <>
          <div className="grid grid-cols-[1fr_1fr_32px] gap-2 px-0.5">
            <span className="text-xs font-medium text-muted-foreground">Name</span>
            <span className="text-xs font-medium text-muted-foreground">Value</span>
            <span />
          </div>
          {rows.map((v, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_32px] gap-2 items-center">
              <Input ref={(el) => (nameRefs.current[i] = el)} value={v.name} onChange={(e) => update(i, "name", e.target.value)} placeholder="variableName" className="font-mono h-8 text-sm" />
              <Input value={v.value} onChange={(e) => update(i, "value", e.target.value)} placeholder="value" className="font-mono h-8 text-sm" />
              <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => remove(i)}>
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

export function SettingsPanel({ project }: { project: Project }) {
  const updateProject = useUpdateProject();
  // view: "globals" | "project" | `env:<id>`
  const [view, setView] = useState<string>("globals");
  const [globals, setGlobals] = useState<VariableRow[]>([]);
  const [environments, setEnvironments] = useState<EnvDraft[]>([]);
  const [renamingEnvId, setRenamingEnvId] = useState<string | null>(null);
  const [deleteEnvId, setDeleteEnvId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setGlobals(objToRows(readGlobals(project.settings)));
    setEnvironments(readEnvironments(project.settings).map((e) => ({ id: e.id, name: e.name, rows: objToRows(e.variables) })));
    setName(project.name || "");
    setDescription(project.description || "");
    // Initialize once per project — avoids clobbering in-progress edits when the
    // project cache updates (e.g. after an immediate env delete).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const addEnv = () => {
    const draft: EnvDraft = { id: genEnvId(), name: `env-${environments.length + 1}`, rows: [] };
    setEnvironments((prev) => [...prev, draft]);
    setView(`env:${draft.id}`);
  };
  const performDeleteEnv = (envId: string) => {
    // Persist the removal immediately, built from the *saved* settings so it
    // doesn't drag in other unsaved edits in this panel.
    const remaining = readEnvironments(project.settings).filter((e) => e.id !== envId);
    const newSettings: Record<string, unknown> = { ...(project.settings || {}) };
    newSettings.environments = remaining.length > 0 ? remaining : undefined;
    updateProject.mutate(
      { id: project.id, data: { settings: newSettings } },
      { onSuccess: () => toast.success("Environment deleted"), onError: () => toast.error("Failed to delete environment") }
    );
    // Reflect in the local draft too.
    setEnvironments((prev) => prev.filter((e) => e.id !== envId));
    setView((cur) => (cur === `env:${envId}` ? "globals" : cur));
    if (renamingEnvId === envId) setRenamingEnvId(null);
  };
  const cloneEnv = (envId: string) => {
    const env = environments.find((e) => e.id === envId);
    if (!env) return;
    const draft: EnvDraft = { id: genEnvId(), name: `${env.name} copy`, rows: env.rows.map((r) => ({ ...r })) };
    setEnvironments((prev) => {
      const idx = prev.findIndex((e) => e.id === envId);
      const next = prev.slice();
      next.splice(idx + 1, 0, draft);
      return next;
    });
    setView(`env:${draft.id}`);
  };
  const renameEnv = (envId: string, n: string) =>
    setEnvironments((prev) => prev.map((e) => (e.id === envId ? { ...e, name: n } : e)));
  const setEnvRows = (envId: string, rows: VariableRow[]) =>
    setEnvironments((prev) => prev.map((e) => (e.id === envId ? { ...e, rows } : e)));

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const globalsObj = rowsToObj(globals);
      const legacyBaseUrl = (project.settings?.baseUrl as string) || "";
      if (legacyBaseUrl && !globalsObj.baseUrl) globalsObj.baseUrl = legacyBaseUrl;

      const envs = environments
        .filter((e) => e.name.trim())
        .map((e) => ({ id: e.id, name: e.name.trim(), variables: rowsToObj(e.rows) }));

      const newSettings: Record<string, unknown> = { ...(project.settings || {}) };
      delete newSettings.baseUrl;
      newSettings.variables = Object.keys(globalsObj).length > 0 ? globalsObj : undefined;
      newSettings.environments = envs.length > 0 ? envs : undefined;

      await updateProject.mutateAsync({
        id: project.id,
        data: { name: name.trim() || project.name, description: description.trim() || null, settings: newSettings },
      });
      toast.success("Settings saved");
    } catch (e) {
      toast.error("Failed to save settings");
      console.error(e);
    } finally {
      setIsSaving(false);
    }
  };

  const navBtn = (active: boolean) =>
    `w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-left ${
      active ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
    }`;

  const selectedEnv = view.startsWith("env:") ? environments.find((e) => `env:${e.id}` === view) || null : null;

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="flex-1 min-h-0 grid grid-cols-[210px_1fr]">
        {/* sub-rail */}
        <nav className="border-r border-border bg-sidebar p-3 overflow-auto">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-2 pb-2">
            Project Settings
          </div>

          <button className={navBtn(view === "globals")} onClick={() => setView("globals")}>
            <Braces className="w-4 h-4" /> Globals
          </button>

          {/* Environments group header + add */}
          <div className="flex items-center gap-1 mt-1 pl-3 pr-1 py-1.5">
            <Layers className="w-4 h-4 text-muted-foreground" />
            <span className="flex-1 text-sm text-muted-foreground">Environments</span>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={addEnv} title="New environment">
              <Plus className="w-3.5 h-3.5" />
            </Button>
          </div>
          {/* Environment list (nested) */}
          <div className="flex flex-col">
            {environments.length === 0 ? (
              <span className="pl-9 pr-2 py-1 text-xs text-muted-foreground/60 italic">No environments</span>
            ) : (
              environments.map((env) => {
                const active = view === `env:${env.id}`;
                return (
                  <div
                    key={env.id}
                    className={`group flex items-center gap-1 rounded-md ${
                      active ? "bg-primary/10" : "hover:bg-sidebar-accent"
                    }`}
                  >
                    {renamingEnvId === env.id ? (
                      <Input
                        autoFocus
                        onFocus={(e) => e.target.select()}
                        value={env.name}
                        onChange={(e) => renameEnv(env.id, e.target.value)}
                        onBlur={() => setRenamingEnvId(null)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === "Escape") setRenamingEnvId(null);
                        }}
                        className="h-7 text-sm mx-1 my-0.5"
                      />
                    ) : (
                      <button
                        className={`flex-1 min-w-0 truncate pl-9 pr-1 py-1.5 text-sm text-left ${
                          active ? "text-primary font-medium" : "text-foreground"
                        }`}
                        onClick={() => setView(`env:${env.id}`)}
                        onDoubleClick={() => setRenamingEnvId(env.id)}
                        title="Double-click to rename"
                      >
                        {env.name || "(unnamed)"}
                      </button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground"
                      onClick={() => setRenamingEnvId(env.id)}
                      title="Rename environment"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground"
                      onClick={() => cloneEnv(env.id)}
                      title="Clone environment"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 mr-1 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleteEnvId(env.id)}
                      title="Delete environment"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                );
              })
            )}
          </div>

          <button className={`${navBtn(view === "project")} mt-1`} onClick={() => setView("project")}>
            <Info className="w-4 h-4" /> Project
          </button>
        </nav>

        {/* content — keys/values (or globals table, or project fields) */}
        <div className="overflow-auto p-6">
          {view === "globals" && (
            <div className="space-y-4 max-w-3xl">
              <div>
                <h3 className="text-base font-semibold">Globals</h3>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Shared variables, available as {"{{variableName}}"} in every environment. Put things like{" "}
                  <code className="px-1 py-0.5 bg-muted rounded">baseUrl</code> here (or override per environment).
                </p>
              </div>
              <VarRows rows={globals} onChange={setGlobals} />
            </div>
          )}

          {selectedEnv && (
            <div className="space-y-4 max-w-3xl">
              <div>
                <h3 className="text-base font-semibold">{selectedEnv.name || "(unnamed)"}</h3>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Variables for this environment. They override globals of the same name when this env is active.
                  Double-click the name in the list to rename.
                </p>
              </div>
              <VarRows rows={selectedEnv.rows} onChange={(rows) => setEnvRows(selectedEnv.id, rows)} />
            </div>
          )}

          {view === "project" && (
            <div className="space-y-4 max-w-xl">
              <div>
                <h3 className="text-base font-semibold">Project</h3>
                <p className="text-sm text-muted-foreground mt-0.5">Name and description for this project.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="proj-name">Name</Label>
                <Input id="proj-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="proj-desc">Description</Label>
                <Textarea id="proj-desc" value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-[80px]" />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-end gap-2 px-6 py-3 border-t border-border bg-sidebar/40">
        <Button onClick={handleSave} disabled={isSaving}>
          {isSaving ? "Saving..." : "Save"}
        </Button>
      </div>

      <AlertDialog open={!!deleteEnvId} onOpenChange={(o) => { if (!o) setDeleteEnvId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete environment?</AlertDialogTitle>
            <AlertDialogDescription>
              "{environments.find((e) => e.id === deleteEnvId)?.name || "This environment"}" and its variables will be
              deleted. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteEnvId) performDeleteEnv(deleteEnvId);
                setDeleteEnvId(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
