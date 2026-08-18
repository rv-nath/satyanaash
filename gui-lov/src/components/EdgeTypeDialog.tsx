import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, ArrowDown } from "lucide-react";
import type { EdgeKind } from "@/lib/api/types";

/**
 * One option, at the dialog's width rather than its text's.
 *
 * `Button`'s base class carries `whitespace-nowrap`, so a description could never wrap: the widest
 * of the three set the button width and all three overflowed `sm:max-w-md`. Latent from the start —
 * two options were simply short enough to hide it — and exposed by the third, whose description has
 * a caveat to state.
 *
 * `w-full` keeps the button inside the dialog, `whitespace-normal` lets the text wrap instead of
 * pushing, and `min-w-0` on the text column below is what actually permits the shrink: a flex item
 * defaults to `min-width: auto` and refuses to go below its content.
 */
const OPTION =
  "h-auto w-full py-4 flex items-start gap-3 justify-start whitespace-normal border-2";

interface EdgeTypeDialogProps {
  open: boolean;
  onSelect: (type: EdgeKind) => void;
  onCancel: () => void;
}

export const EdgeTypeDialog = ({ open, onSelect, onCancel }: EdgeTypeDialogProps) => {
  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Select Connection Type</DialogTitle>
          <DialogDescription>
            Choose the type of flow path for this connection
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 mt-4">
          <Button
            onClick={() => onSelect('success')}
            className={`${OPTION} bg-success/10 hover:bg-success/20 text-success-foreground border-success`}
            variant="outline"
          >
            <CheckCircle2 className="h-5 w-5 text-success flex-shrink-0 mt-0.5" />
            <div className="flex min-w-0 flex-col items-start text-left">
              <div className="font-semibold text-success">Success Path</div>
              <div className="text-xs text-muted-foreground font-normal">
                Execute next node when this test passes
              </div>
            </div>
          </Button>
          <Button
            onClick={() => onSelect('failure')}
            className={`${OPTION} bg-destructive/10 hover:bg-destructive/20 text-destructive-foreground border-destructive`}
            variant="outline"
          >
            <XCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
            <div className="flex min-w-0 flex-col items-start text-left">
              <div className="font-semibold text-destructive">Failure Path</div>
              <div className="text-xs text-muted-foreground font-normal">
                Execute next node when this test fails
              </div>
            </div>
          </Button>
          {/*
            Third, and last, because it is the least specific of the three — read the two verdicts
            first, then the one that ignores them.

            It exists because "carry on either way" had no way to be said. The only expression of
            it was two edges to the same target, one Success and one Failure, and parallel edges
            between a single pair of nodes overlap exactly on the canvas: the graph then showed a
            lone Failure line where a plain step was meant. Muted rather than a third accent
            colour — the palette's red and green mean verdicts here, and this edge is the absence
            of a verdict, not another one.
          */}
          <Button
            onClick={() => onSelect('any')}
            className={`${OPTION} bg-muted/40 hover:bg-muted/70 border-muted-foreground/30`}
            variant="outline"
          >
            <ArrowDown className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
            <div className="flex min-w-0 flex-col items-start text-left">
              <div className="font-semibold text-foreground">Always</div>
              <div className="text-xs text-muted-foreground font-normal">
                Execute next node whether it passes or fails. The run still fails if it failed.
              </div>
            </div>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
