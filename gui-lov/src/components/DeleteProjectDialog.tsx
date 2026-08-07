import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { testCasesApi, flowsApi, suitesApi, runsApi } from "@/lib/api";
import type { Project } from "@/lib/api/types";
import { contentsKnown, lossSummary, nameMatches } from "@/lib/deleteProject";

/**
 * The only delete in this app that nobody can walk back.
 *
 * Every other one removes a thing you could rebuild in a minute. A project cascades — requests,
 * flows, suites and the entire run history — with no export and no undo. It had no confirmation
 * at all, which made the most destructive action in the app the easiest to trigger by accident.
 *
 * Two things beyond "are you sure?", each earning its place:
 *
 * - **The counts**, fetched when this opens. A confirmation with no stakes in it is a rubber
 *   stamp, and the numbers are the only part anyone actually reads.
 * - **Typing the name.** A second click is a reflex; typing is a decision.
 */
interface Props {
  project: Project;
  onClose: () => void;
  onConfirm: () => void;
  deleting?: boolean;
}

export const DeleteProjectDialog = ({ project, onClose, onConfirm, deleting }: Props) => {
  const [typed, setTyped] = useState("");

  // Fetched on open rather than with the project list: four requests per card would be paid on
  // every visit to a page where nobody is deleting anything.
  const counts = useQuery({
    queryKey: ["project-contents", project.id],
    queryFn: async () => {
      const [requests, flows, suites, runs] = await Promise.all([
        testCasesApi.list(project.id),
        flowsApi.list(project.id),
        suitesApi.list(project.id),
        // Ad-hoc runs count too: they are history, and history is what cannot be rebuilt.
        runsApi.list(project.id, { includeAdhoc: true }),
      ]);
      return {
        requests: requests.length,
        flows: flows.length,
        suites: suites.length,
        runs: runs.runs.length,
      };
    },
  });

  const contents = counts.data ?? {};
  const summary = lossSummary(contents);
  const known = contentsKnown(contents);
  const canDelete = nameMatches(typed, project.name) && !deleting;

  return (
    <AlertDialog open onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            Delete {project.name}?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              {counts.isLoading ? (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Checking what is in it…
                </p>
              ) : summary ? (
                <p>
                  This deletes <span className="font-medium text-foreground">{summary}</span>, and
                  every result those runs recorded.
                </p>
              ) : known ? (
                <p className="text-muted-foreground">This project is empty.</p>
              ) : (
                // The counts could not be fetched. Deleting is still allowed — refusing would
                // strand someone whose server is down — but the dialog does not pretend to know
                // what it is about to destroy.
                <p className="text-warning">
                  Could not check what is in this project, so it may hold requests, flows and run
                  history.
                </p>
              )}
              <p className="text-muted-foreground">
                There is no undo and no export. Everything above is gone for good.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div>
          <Label htmlFor="confirm-name" className="text-xs text-muted-foreground">
            Type <span className="font-mono text-foreground">{project.name}</span> to confirm
          </Label>
          <Input
            id="confirm-name"
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the only field in a dialog the
            // author opened deliberately, and the one thing standing between them and the button.
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              // Enter submits only once the name matches, so the reflex that opened this dialog
              // cannot also confirm it.
              if (e.key === "Enter" && canDelete) onConfirm();
            }}
            placeholder={project.name}
            autoComplete="off"
            spellCheck={false}
            className="mt-1.5 h-8 font-mono text-xs"
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              // Radix closes the dialog on any action click; without this a mis-click while the
              // name is wrong would dismiss the guard rather than being ignored.
              if (!canDelete) {
                e.preventDefault();
                return;
              }
              onConfirm();
            }}
            disabled={!canDelete}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:pointer-events-none disabled:opacity-50"
          >
            {deleting && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
            Delete this project
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default DeleteProjectDialog;
