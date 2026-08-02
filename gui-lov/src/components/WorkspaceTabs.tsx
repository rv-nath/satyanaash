import { useState } from "react";
import { X, Settings, Workflow, Layers, History, Play, Pin } from "lucide-react";
import { Input } from "@/components/ui/input";

export interface RenderTab {
  key: string;            // "flow:<id>" | "test:<id>" | "suite:<id>" | "run:<id>"
  kind: "flow" | "test" | "suite" | "run";
  label: string;
  method?: string;        // test tabs
  dirty?: boolean;
  /** False for a tab with nothing to rename yet — an unsaved New Test has no
   *  record on the server, and its name belongs to the editor. */
  renameable?: boolean;
  /** Run tabs: held back so the next run opens beside it rather than over it. */
  pinned?: boolean;
}

interface Props {
  tabs: RenderTab[];
  settingsOpen: boolean;
  settingsDirty?: boolean;
  /** Run history — one surface for the project, so a singleton like Settings. */
  runsOpen?: boolean;
  active: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  /** Commit a new name for a tab. Omit and double-clicking does nothing. */
  onRename?: (key: string, name: string) => void;
  /** Hold a run tab back so the next run opens beside it rather than over it. */
  onTogglePin?: (key: string) => void;
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
  onDoubleClick,
  children,
}: {
  tabKey: string;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
  onDoubleClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`${base} ${active ? activeCls : idleCls}`}>
      {/* teal accent strip on the active tab */}
      {active && <span className="pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded-t bg-primary" />}
      <button onClick={onActivate} onDoubleClick={onDoubleClick} className="flex items-center gap-1.5">
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

export function WorkspaceTabs({ tabs, settingsOpen, settingsDirty, runsOpen, active, onActivate, onClose, onRename, onTogglePin }: Props) {
  // Which tab is being renamed, and the name so far. Held here rather than by the page:
  // it is nobody else's business, and the page is long enough.
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const startRename = (t: RenderTab) => {
    if (!onRename || t.renameable === false) return;
    setRenamingKey(t.key);
    setDraft(t.label);
  };

  const cancelRename = () => {
    setRenamingKey(null);
    setDraft("");
  };

  const commitRename = (t: RenderTab) => {
    const name = draft.trim();
    // A blank name would leave a tab you cannot read, and an unchanged one is not
    // worth a request — either way, put the label back.
    if (name && name !== t.label) onRename?.(t.key, name);
    cancelRename();
  };

  return (
    <div className="flex items-end gap-0.5 border-b border-border bg-card px-2 pt-1.5 min-h-[38px]">
      {tabs.map((t) => (
        <TabShell
          key={t.key}
          tabKey={t.key}
          active={active === t.key}
          onActivate={() => onActivate(t.key)}
          onClose={() => onClose(t.key)}
          onDoubleClick={() => startRename(t)}
        >
          {t.kind === "flow" ? (
            <Workflow className="h-3.5 w-3.5 text-node-group" />
          ) : t.kind === "suite" ? (
            <Layers className="h-3.5 w-3.5 text-primary" />
          ) : t.kind === "run" ? (
            <Play className="h-3 w-3 text-primary" />
          ) : (
            <span className={`text-[9px] font-bold uppercase ${active === t.key ? "text-primary" : "text-muted-foreground"}`}>
              {t.method}
            </span>
          )}
          {renamingKey === t.key ? (
            <Input
              autoFocus
              aria-label={`rename ${t.key}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              // The field sits inside the tab's activate button; without this, typing
              // or clicking in it would keep re-activating the tab.
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onBlur={() => commitRename(t)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename(t);
                if (e.key === "Escape") cancelRename();
              }}
              // Grows with the name, so committing doesn't make the tab jump.
              style={{ width: `${Math.max(8, draft.length + 1)}ch` }}
              className="h-5 min-w-[6rem] px-1 py-0 text-xs"
            />
          ) : (
            <span
              className={t.dirty ? "italic" : undefined}
              title={onRename && t.renameable !== false ? "Double-click to rename" : undefined}
            >
              {t.label}
            </span>
          )}
          {t.dirty && (
            <span
              className="h-2 w-2 shrink-0 rounded-full bg-warning"
              title="Unsaved changes"
              aria-label="Unsaved changes"
            />
          )}
          {/* A span, not a button: this sits inside the tab's activate button, and
              nesting buttons is invalid HTML. */}
          {t.kind === "run" && onTogglePin && (
            <span
              role="button"
              tabIndex={-1}
              aria-label={t.pinned ? `Unpin ${t.label}` : `Pin ${t.label}`}
              aria-pressed={!!t.pinned}
              title={
                t.pinned
                  ? "Pinned — the next run opens beside this one"
                  : "Pin, to keep this run when the next one starts"
              }
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin(t.key);
              }}
              className={`shrink-0 rounded p-0.5 ${
                t.pinned ? "text-primary" : "opacity-0 hover:opacity-100 group-hover:opacity-60"
              }`}
            >
              <Pin className="h-3 w-3" fill={t.pinned ? "currentColor" : "none"} />
            </span>
          )}
        </TabShell>
      ))}

      {runsOpen && (
        <TabShell
          tabKey="runs"
          active={active === "runs"}
          onActivate={() => onActivate("runs")}
          onClose={() => onClose("runs")}
        >
          <History className="h-3.5 w-3.5" />
          <span>Runs</span>
        </TabShell>
      )}

      {settingsOpen && (
        <TabShell
          tabKey="settings"
          active={active === "settings"}
          onActivate={() => onActivate("settings")}
          onClose={() => onClose("settings")}
        >
          <Settings className="h-3.5 w-3.5" />
          <span className={settingsDirty ? "italic" : undefined}>Settings</span>
          {settingsDirty && (
            <span
              className="h-2 w-2 shrink-0 rounded-full bg-warning"
              title="Unsaved changes"
              aria-label="Unsaved changes"
            />
          )}
        </TabShell>
      )}
    </div>
  );
}
