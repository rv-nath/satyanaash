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
  "group relative flex items-center gap-1.5 rounded-t-md border border-b-0 px-3 py-1.5 text-xs whitespace-nowrap transition-colors";
const activeCls = "-mb-px bg-background text-foreground border-border font-medium";
const idleCls = "text-muted-foreground border-transparent hover:bg-muted/60";

function TabShell({
  tabKey,
  active,
  onActivate,
  onClose,
  children,
}: {
  tabKey: string;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`${base} ${active ? activeCls : idleCls}`}>
      {/* teal accent strip on the active tab */}
      {active && <span className="pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded-t bg-primary" />}
      <button onClick={onActivate} className="flex items-center gap-1.5">
        {children}
      </button>
      <button
        aria-label={`close ${tabKey}`}
        onClick={onClose}
        className="rounded-sm p-0.5 opacity-50 hover:bg-muted hover:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

export function WorkspaceTabs({ tabs, settingsOpen, active, onActivate, onClose }: Props) {
  return (
    <div className="flex items-end gap-0.5 border-b border-border bg-card px-2 pt-1.5 min-h-[38px]">
      {tabs.map((t) => (
        <TabShell
          key={t.key}
          tabKey={t.key}
          active={active === t.key}
          onActivate={() => onActivate(t.key)}
          onClose={() => onClose(t.key)}
        >
          {t.kind === "flow" ? (
            <Workflow className="h-3.5 w-3.5 text-node-group" />
          ) : (
            <span className={`text-[9px] font-bold uppercase ${active === t.key ? "text-primary" : "text-muted-foreground"}`}>
              {t.method}
            </span>
          )}
          {t.label}
          {t.dirty && <span className="h-1.5 w-1.5 rounded-full bg-warning" />}
        </TabShell>
      ))}

      {settingsOpen && (
        <TabShell
          tabKey="settings"
          active={active === "settings"}
          onActivate={() => onActivate("settings")}
          onClose={() => onClose("settings")}
        >
          <Settings className="h-3.5 w-3.5" />
          Settings
        </TabShell>
      )}
    </div>
  );
}
