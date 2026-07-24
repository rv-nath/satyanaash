import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Plus, X, Trash2, Braces, Layers, Info } from "lucide-react";
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
type Section = "globals" | "environments" | "project";

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
              <Input value={v.name} onChange={(e) => update(i, "name", e.target.value)} placeholder="variableName" className="font-mono h-8 text-sm" />
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
  const [section, setSection] = useState<Section>("globals");
  const [globals, setGlobals] = useState<VariableRow[]>([]);
  const [environments, setEnvironments] = useState<EnvDraft[]>([]);
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setGlobals(objToRows(readGlobals(project.settings)));
    const envs = readEnvironments(project.settings).map((e) => ({ id: e.id, name: e.name, rows: objToRows(e.variables) }));
    setEnvironments(envs);
    setSelectedEnvId(envs[0]?.id ?? null);
    setName(project.name || "");
    setDescription(project.description || "");
  }, [project]);

  const addEnv = () => {
    const draft: EnvDraft = { id: genEnvId(), name: `env-${environments.length + 1}`, rows: [] };
    setEnvironments((prev) => [...prev, draft]);
    setSelectedEnvId(draft.id);
  };
  const removeEnv = (envId: string) => {
    setEnvironments((prev) => prev.filter((e) => e.id !== envId));
    setSelectedEnvId((cur) => (cur === envId ? null : cur));
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
      delete newSettings.baseUrl; // retired
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

  const nav: { key: Section; label: string; Icon: typeof Braces }[] = [
    { key: "globals", label: "Globals", Icon: Braces },
    { key: "environments", label: "Environments", Icon: Layers },
    { key: "project", label: "Project", Icon: Info },
  ];

  const selectedEnv = environments.find((e) => e.id === selectedEnvId) || null;

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="flex-1 min-h-0 grid grid-cols-[190px_1fr]">
        {/* sub-rail */}
        <nav className="border-r border-border bg-sidebar p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-2 pb-2">
            Project Settings
          </div>
          {nav.map(({ key, label, Icon }) => (
            <button
              key={key}
              onClick={() => setSection(key)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-left ${
                section === key
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </nav>

        {/* content */}
        <div className="overflow-auto p-6">
          {section === "globals" && (
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

          {section === "environments" && (
            <div className="space-y-4">
              <div>
                <h3 className="text-base font-semibold">Environments</h3>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Switchable var sets (dev / staging / prod). An environment value overrides a global of the same name.
                  Pick the active one from the header dropdown.
                </p>
              </div>
              <div className="grid grid-cols-[190px_1fr] gap-6 items-start">
                <div>
                  <div className="flex flex-col gap-1">
                    {environments.map((env) => (
                      <button
                        key={env.id}
                        onClick={() => setSelectedEnvId(env.id)}
                        className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm text-left ${
                          selectedEnvId === env.id ? "bg-primary/10 text-primary font-medium" : "hover:bg-sidebar-accent"
                        }`}
                      >
                        {env.name || "(unnamed)"}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={addEnv}
                    className="mt-2 w-full border border-dashed border-border rounded-md py-2 text-xs text-muted-foreground hover:border-primary hover:text-primary"
                  >
                    + Add environment
                  </button>
                </div>

                <div>
                  {selectedEnv ? (
                    <>
                      <div className="flex items-center gap-2 mb-3">
                        <Input
                          value={selectedEnv.name}
                          onChange={(e) => renameEnv(selectedEnv.id, e.target.value)}
                          placeholder="environment name"
                          className="h-8 text-sm font-medium max-w-xs"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => removeEnv(selectedEnv.id)}
                          title="Delete environment"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                      <VarRows rows={selectedEnv.rows} onChange={(rows) => setEnvRows(selectedEnv.id, rows)} />
                    </>
                  ) : (
                    <div className="border border-dashed rounded-md p-6 text-center text-sm text-muted-foreground">
                      No environment selected. Add one to switch base URLs / credentials per stage.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {section === "project" && (
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
    </div>
  );
}
