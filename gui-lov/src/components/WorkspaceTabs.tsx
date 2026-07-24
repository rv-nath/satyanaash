import { X, Settings, Workflow } from "lucide-react";

export interface RenderTab {
  key: string;            // "flow:<id>" | "test:<id>"
  kind: "flow" | "test";
  label: string;
  method?: string;        // test tabs
  dirty?: boolean;
}

interface Props {
  tabs: RenderTab[];
  settingsOpen: boolean;
  active: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
}

const base =
  "flex items-center gap-1.5 rounded-t-md border border-b-0 px-3 py-1.5 text-xs whitespace-nowrap";
const activeCls = "bg-background text-foreground border-border";
const idleCls = "text-muted-foreground border-transparent";

export function WorkspaceTabs({ tabs, settingsOpen, active, onActivate, onClose }: Props) {
  return (
    <div className="flex items-end gap-0.5 border-b border-border bg-card px-2 pt-1.5 min-h-[38px]">
      {tabs.map((t) => (
        <div key={t.key} className={`${base} ${active === t.key ? activeCls : idleCls}`}>
          <button onClick={() => onActivate(t.key)} className="flex items-center gap-1.5">
            {t.kind === "flow" ? (
              <Workflow className="h-3.5 w-3.5 text-node-group" />
            ) : (
              <span className="text-[9px] font-bold uppercase text-muted-foreground">{t.method}</span>
            )}
            {t.label}
            {t.dirty && <span className="h-1.5 w-1.5 rounded-full bg-warning" />}
          </button>
          <button
            aria-label={`close ${t.key}`}
            onClick={() => onClose(t.key)}
            className="opacity-60 hover:opacity-100"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}

      {settingsOpen && (
        <div className={`${base} ${active === "settings" ? activeCls : idleCls}`}>
          <button onClick={() => onActivate("settings")} className="flex items-center gap-1.5">
            <Settings className="h-3.5 w-3.5" />
            Settings
          </button>
          <button
            aria-label="close settings"
            onClick={() => onClose("settings")}
            className="opacity-60 hover:opacity-100"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}
