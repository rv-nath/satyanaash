import { FileCode, FolderTree, HardDrive, History, Layers, PanelsTopLeft, Settings } from "lucide-react";
import { RAIL_VIEWS, type RailView } from "@/lib/railViews";

/**
 * The far-left rail.
 *
 * Two groups, and the divider between them is load-bearing. Above it, each entry picks what the
 * **sidebar** shows. Below it, each entry fills the **main area** instead.
 *
 * Files started above the line and had to move: swapping the sidebar while the main area stayed
 * on the welcome screen is not what clicking "Files" means, and a file's reference — the whole
 * point — cannot be read in a 200px column anyway.
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
  /** Settings is a page, not a sidebar view — a separate prop so it cannot be confused. */
  onOpenSettings: () => void;
  /** Files is a page too: its output is a long reference string that needs the width. */
  onOpenFiles: () => void;
  filesActive?: boolean;
  /** Marks the gear when the settings tab is the active surface. */
  settingsActive?: boolean;
}

export const ActivityRail = ({ view, onSelect, onOpenSettings, onOpenFiles, settingsActive, filesActive }: Props) => (
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

    {/* Below the divider: entries that fill the main area rather than the sidebar. */}
    <RailButton
      icon={HardDrive}
      label="Files"
      title="Files the API under test can fetch — opens in the main area"
      active={filesActive === true}
      onClick={onOpenFiles}
    />
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
