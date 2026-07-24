import { Plus, Workflow, Globe } from "lucide-react";

interface WorkspaceWelcomeProps {
  onNewTest: () => void;
  onNewFlow: () => void;
  onOpenEnvironments: () => void;
}

const cards = [
  {
    key: "test",
    icon: Plus,
    title: "New test case",
    body: "Define a request and the checks it must pass.",
  },
  {
    key: "flow",
    icon: Workflow,
    title: "New flow",
    body: "Chain tests into an end-to-end scenario.",
  },
  {
    key: "env",
    icon: Globe,
    title: "Environments",
    body: "Manage variables and base URLs per env.",
  },
] as const;

export const WorkspaceWelcome = ({ onNewTest, onNewFlow, onOpenEnvironments }: WorkspaceWelcomeProps) => {
  const actions: Record<string, () => void> = {
    test: onNewTest,
    flow: onNewFlow,
    env: onOpenEnvironments,
  };

  return (
    <div className="flex h-full flex-col items-center justify-center overflow-auto p-8 text-center">
      {/* Brand kicker — the S-flow that arrives at a verified check */}
      <div className="mb-5 flex items-center gap-2">
        <svg aria-hidden="true" viewBox="0 0 40 40" className="w-6" fill="none">
          <path d="M29 9 C 16 6, 11 17, 20 25 C 29 33, 23 44, 12 41" stroke="hsl(var(--muted-foreground))" strokeWidth={3} strokeLinecap="round" opacity={0.4} />
          <circle cx="29" cy="9" r="3.4" fill="hsl(var(--background))" stroke="hsl(var(--muted-foreground))" strokeWidth={2.4} opacity={0.55} />
          <circle cx="12" cy="35" r="6.5" fill="hsl(var(--primary))" />
          <path d="M9 35 l2.4 2.4 L15.5 30.4" stroke="hsl(var(--primary-foreground))" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="font-mono text-xs lowercase tracking-[0.30em] text-muted-foreground pl-[0.30em]">
          satyanaash
        </span>
      </div>

      {/* Hero headline */}
      <h1 className="max-w-[18ch] text-[26px] font-semibold leading-[1.12] tracking-tight text-foreground">
        Build a request. Chain it into a <span className="text-primary">flow</span>. Watch it prove itself.
      </h1>
      <p className="mt-3.5 max-w-[50ch] text-sm leading-relaxed text-muted-foreground">
        Author API test cases, wire them together on a canvas, and run the whole scenario against any environment.
      </p>

      {/* Action cards */}
      <div className="mt-8 grid w-full max-w-[640px] grid-cols-1 gap-3 text-left sm:grid-cols-3">
        {cards.map(({ key, icon: Icon, title, body }) => (
          <button
            key={key}
            type="button"
            onClick={actions[key]}
            className="group flex flex-col gap-3 rounded-xl border border-border bg-card p-[18px] transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-[0_6px_18px_-12px_hsl(var(--primary)/0.5)]"
          >
            <span className="flex h-[38px] w-[38px] items-center justify-center rounded-[10px] bg-primary/10 text-primary">
              <Icon className="h-[19px] w-[19px]" strokeWidth={2} />
            </span>
            <span className="text-sm font-semibold text-foreground">{title}</span>
            <span className="-mt-2 text-xs leading-snug text-muted-foreground">{body}</span>
          </button>
        ))}
      </div>
    </div>
  );
};
