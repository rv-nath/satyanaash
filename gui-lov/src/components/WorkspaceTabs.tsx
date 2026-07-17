import { X } from "lucide-react";
import type { WorkspaceTab } from "@/lib/workspaceTabs";

interface TabInfo {
  id: string;
  name: string;
  method: string;
  dirty?: boolean;
}

interface Props {
  openTestIds: string[];
  active: WorkspaceTab;
  tests: TabInfo[];
  onActivate: (tab: WorkspaceTab) => void;
  onClose: (id: string) => void;
}

export function WorkspaceTabs({ openTestIds, active, tests, onActivate, onClose }: Props) {
  const byId = (id: string) => tests.find((t) => t.id === id);
  return (
    <div className="flex items-end gap-0.5 border-b border-border bg-card px-2 pt-1.5">
      <button
        onClick={() => onActivate("canvas")}
        className={`rounded-t-md border border-b-0 px-3 py-1.5 text-xs ${
          active === "canvas"
            ? "bg-background text-foreground border-border"
            : "text-muted-foreground border-transparent"
        }`}
      >
        ◈ Flow
      </button>
      {openTestIds.map((id) => {
        const t = byId(id);
        const isActive = active === id;
        return (
          <div
            key={id}
            className={`flex items-center gap-1.5 rounded-t-md border border-b-0 px-3 py-1.5 text-xs ${
              isActive
                ? "bg-background text-foreground border-border"
                : "text-muted-foreground border-transparent"
            }`}
          >
            <button onClick={() => onActivate(id)} className="flex items-center gap-1.5">
              <span className="text-[9px] font-bold uppercase text-muted-foreground">{t?.method}</span>
              {t?.name ?? id}
              {t?.dirty && <span className="h-1.5 w-1.5 rounded-full bg-warning" />}
            </button>
            <button
              aria-label={`close ${id}`}
              onClick={() => onClose(id)}
              className="opacity-60 hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
