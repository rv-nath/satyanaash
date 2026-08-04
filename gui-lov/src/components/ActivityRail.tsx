import { FileCode, FolderTree, History, Layers, PanelsTopLeft, Settings } from "lucide-react";
import { RAIL_VIEWS, type RailView } from "@/lib/railViews";

/**
 * The far-left rail: what the sidebar shows.
 *
 * Two groups, and the divider between them is load-bearing. The top group obeys one rule —
 * each entry picks what the sidebar beside it shows. The bottom entry does something else
 * entirely: it opens a workspace tab. Giving them the same look with no separation would
 * make Settings read as a sidebar view that happens to be broken.
 *
 * Icon *with* a label, not icon-only. Six entries is more than tooltips carry comfortably,
 * and the labels are what make the two groups legible as two groups.
 */
const ICONS: Record<RailView, typeof FileCode> = {
  workspace: PanelsTopLeft,
  tests: FileCode,
  flows: FolderTree,
  suites: Layers,
  runs: History,
};

interface Props {
  view: RailView;
  onSelect: (view: RailView) => void;
  /** Settings is a tab, not a sidebar view — a separate prop so it cannot be confused. */
  onOpenSettings: () => void;
  /** Marks the gear when the settings tab is the active surface. */
  settingsActive?: boolean;
}

export const ActivityRail = ({ view, onSelect, onOpenSettings, settingsActive }: Props) => (
  <nav
    aria-label="Sidebar views"
    // select-none: these labels are navigation, and a drag begun on the canvas used to
    // select them along with everything else in the frame.
    className="flex w-16 shrink-0 select-none flex-col border-r border-sidebar-border bg-sidebar py-1"
  >
    {RAIL_VIEWS.map((entry) => (
      <RailButton
        key={entry.id}
        icon={ICONS[entry.id]}
        label={entry.label}
        title={entry.hint}
        active={view === entry.id}
        onClick={() => onSelect(entry.id)}
      />
    ))}

    <div className="flex-1" />
    <div className="mx-3 my-1 h-px bg-sidebar-border" />

    <RailButton
      icon={Settings}
      label="Settings"
      title="Project settings — opens in a tab"
      active={settingsActive === true}
      onClick={onOpenSettings}
    />
  </nav>
);

const RailButton = ({
  icon: Icon,
  label,
  title,
  active,
  onClick,
}: {
  icon: typeof FileCode;
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    // `aria-current` rather than `aria-pressed`: these are navigation, not toggles — one is
    // always the one you are on, and pressing it again does nothing.
    aria-current={active ? "true" : undefined}
    className={`flex flex-col items-center gap-0.5 py-2 text-[9px] transition-colors ${
      active
        ? "text-primary"
        : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
    }`}
  >
    {/* The active marker is a left edge bar, so it reads at a glance in a column of
        same-sized icons — colour alone is not enough at 9px. */}
    <span className="relative flex w-full justify-center">
      {active && (
        <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-primary" />
      )}
      <Icon className="h-[18px] w-[18px]" />
    </span>
    <span className="max-w-full truncate px-1">{label}</span>
  </button>
);

export default ActivityRail;
