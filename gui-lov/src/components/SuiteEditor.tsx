import { useMemo } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Play, Layers, Workflow, Square } from "lucide-react";
import { suitesApi, flowsApi, testCasesApi } from "@/lib/api";
import type { MemberKind, Suite } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { useTestProject } from "@/contexts/TestProjectContext";
import {
  allMembers,
  canRun,
  coversEverything,
  isSelected,
  memberNote,
  runLabel,
  toggleMember,
} from "@/lib/suites";

/**
 * Building a suite: tick what goes in, in the order it will run.
 *
 * A new suite is **blank**. "Everything" is a deliberate choice for the one suite that
 * wants to pick up tomorrow's new flow on its own, not a default — a suite that cannot
 * say what it covers until it has run isn't much of a suite.
 */
interface Props {
  suiteId: string;
  projectId: string;
}

const SuiteEditor = ({ suiteId, projectId }: Props) => {
  const queryClient = useQueryClient();
  const { executeSuite, isExecuting, cancelExecution } = useTestProject();

  const { data: suite } = useQuery({
    queryKey: ["suite", suiteId],
    queryFn: () => suitesApi.get(suiteId),
  });
  const { data: flows = [] } = useQuery({
    queryKey: ["flows", projectId],
    queryFn: () => flowsApi.list(projectId),
  });
  const { data: tests = [] } = useQuery({
    queryKey: ["test-cases", projectId],
    queryFn: () => testCasesApi.list(projectId),
  });

  const available = useMemo(() => allMembers(flows, tests), [flows, tests]);

  const save = useMutation({
    mutationFn: (patch: Parameters<typeof suitesApi.update>[1]) =>
      suitesApi.update(suiteId, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(["suite", suiteId], updated);
      queryClient.invalidateQueries({ queryKey: ["suites", projectId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!suite) {
    return <p className="p-6 text-sm text-muted-foreground">Loading suite…</p>;
  }

  const everything = coversEverything(suite);

  const toggle = (kind: MemberKind, id: string) =>
    save.mutate({ members: toggleMember(suite, kind, id, available) });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Layers className="h-4 w-4 shrink-0 text-primary" />
        <Input
          defaultValue={suite.name}
          key={suite.id}
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name && name !== suite.name) save.mutate({ name });
          }}
          className="h-7 max-w-xs text-sm"
          aria-label="Suite name"
        />
        <div className="flex-1" />
        {isExecuting ? (
          <Button variant="destructive" size="sm" onClick={cancelExecution}>
            <Square className="mr-1.5 h-3 w-3" /> Stop
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={!canRun(suite, available)}
            onClick={() => executeSuite(suite.id, suite.name)}
            title={
              canRun(suite, available)
                ? "Run every selected member, one after another"
                : "Tick something first"
            }
          >
            <Play className="mr-1.5 h-3 w-3" /> {runLabel(suite, available)}
          </Button>
        )}
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4">
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3">
            <Checkbox
              checked={everything}
              onCheckedChange={(checked) =>
                // Ticking clears the list to "unset"; unticking has to materialise the
                // full list first, or the one thing excluded becomes the only thing kept.
                save.mutate({ members: checked ? null : available })
              }
              aria-label="Everything in this project"
            />
            <span className="min-w-0">
              <span className="block text-sm">Everything in this project</span>
              <span className="block text-xs text-muted-foreground">
                Auto-includes anything added later. Leave this off to pick members yourself.
              </span>
            </span>
          </label>

          <Section title="Flows" count={flows.length}>
            {flows.map((flow) => (
              <MemberRow
                key={flow.id}
                icon={<Workflow className="h-3.5 w-3.5 shrink-0 text-node-group" />}
                name={flow.name}
                checked={isSelected(suite, "flow", flow.id)}
                disabled={everything}
                onToggle={() => toggle("flow", flow.id)}
              />
            ))}
          </Section>

          <Section title="Tests on their own" count={tests.length}>
            {tests.map((test) => (
              <MemberRow
                key={test.id}
                icon={
                  <span className="w-10 shrink-0 text-[9px] font-bold uppercase text-muted-foreground">
                    {test.method}
                  </span>
                }
                name={test.name}
                note={memberNote(test)}
                checked={isSelected(suite, "test", test.id)}
                disabled={everything}
                onToggle={() => toggle("test", test.id)}
              />
            ))}
          </Section>

          {/* Said once, here, rather than discovered in a wall of red results. A test that
              needs something an earlier step produces will fail on its own. */}
          <p className="mt-4 text-xs text-muted-foreground">
            A test listed here runs on its own, with its dataset if it has one. One that
            needs a token an earlier step produces belongs in a flow instead.
          </p>
        </div>
      </ScrollArea>
    </div>
  );
};

const Section = ({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) => (
  <div className="mt-4">
    <div className="flex items-center gap-2 px-1 pb-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </span>
      <span className="text-[10px] text-muted-foreground/60">{count}</span>
    </div>
    {count === 0 ? (
      <p className="px-1 text-xs text-muted-foreground/70">None yet.</p>
    ) : (
      <div className="divide-y divide-border/40 rounded-md border border-border">{children}</div>
    )}
  </div>
);

const MemberRow = ({
  icon,
  name,
  note,
  checked,
  disabled,
  onToggle,
}: {
  icon: React.ReactNode;
  name: string;
  note?: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) => (
  <label
    className={`flex items-center gap-3 px-3 py-1.5 text-sm ${
      disabled ? "opacity-60" : "cursor-pointer hover:bg-muted/20"
    }`}
  >
    <Checkbox
      checked={checked}
      disabled={disabled}
      onCheckedChange={onToggle}
      aria-label={name}
    />
    {icon}
    <span className="min-w-0 flex-1 truncate">{name}</span>
    {note && <span className="shrink-0 text-xs text-muted-foreground">{note}</span>}
  </label>
);

export default SuiteEditor;
