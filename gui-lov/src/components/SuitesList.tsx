import { useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Layers, Plus, Trash2 } from "lucide-react";
import { suitesApi } from "@/lib/api";
import type { Suite } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { coversEverything } from "@/lib/suites";

/**
 * The suites rail: create one, open one.
 *
 * A new suite is created **blank** — `members: []`, not an omitted field. Omitting it
 * means "everything in the project", which is a choice the author makes in the editor, not
 * a starting point that hides what the suite covers.
 */
interface Props {
  projectId: string;
  onOpenSuite: (id: string) => void;
}

export const SuitesList = ({ projectId, onOpenSuite }: Props) => {
  const queryClient = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<Suite | null>(null);

  const { data: suites = [] } = useQuery({
    queryKey: ["suites", projectId],
    queryFn: () => suitesApi.list(projectId),
  });

  const create = useMutation({
    mutationFn: () => suitesApi.create(projectId, { name: "New Suite", members: [] }),
    onSuccess: (suite) => {
      queryClient.invalidateQueries({ queryKey: ["suites", projectId] });
      onOpenSuite(suite.id);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => suitesApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["suites", projectId] });
      // Its runs are not deleted with it — the history outlives what it ran.
      toast.success("Suite deleted. Its runs are still in the history.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 items-center gap-2 border-b border-sidebar-border px-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Suites
        </span>
        <span className="text-[10px] text-muted-foreground/60">{suites.length}</span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => create.mutate()}
          title="New suite"
          aria-label="New suite"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        {suites.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">
            A suite runs several flows and tests as one. Nothing here yet.
          </p>
        ) : (
          <ul className="py-1">
            {suites.map((suite) => (
              <li key={suite.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onDoubleClick={() => onOpenSuite(suite.id)}
                  onKeyDown={(e) => e.key === "Enter" && onOpenSuite(suite.id)}
                  title="Double-click to open"
                  className="group flex cursor-pointer items-center gap-2 px-3 py-1 text-sm hover:bg-sidebar-accent/50"
                >
                  <Layers className="h-3.5 w-3.5 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate">{suite.name}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {coversEverything(suite) ? "all" : suite.members!.length}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 shrink-0 opacity-0 hover:text-destructive group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPendingDelete(suite);
                    }}
                    aria-label={`Delete ${suite.name}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={`Delete "${pendingDelete?.name}"?`}
        description="The suite goes; its past runs stay in the history."
        confirmLabel="Delete"
        onConfirm={() => {
          if (pendingDelete) remove.mutate(pendingDelete.id);
          setPendingDelete(null);
        }}
      />
    </div>
  );
};

export default SuitesList;
