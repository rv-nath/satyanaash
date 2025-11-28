import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle } from "lucide-react";

interface EdgeTypeDialogProps {
  open: boolean;
  onSelect: (type: 'success' | 'failure') => void;
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
            className="h-auto py-4 flex items-start gap-3 justify-start bg-success/10 hover:bg-success/20 text-success-foreground border-2 border-success"
            variant="outline"
          >
            <CheckCircle2 className="h-5 w-5 text-success flex-shrink-0 mt-0.5" />
            <div className="flex flex-col items-start text-left">
              <div className="font-semibold text-success">Success Path</div>
              <div className="text-xs text-muted-foreground font-normal">
                Execute next node when this test passes
              </div>
            </div>
          </Button>
          <Button
            onClick={() => onSelect('failure')}
            className="h-auto py-4 flex items-start gap-3 justify-start bg-destructive/10 hover:bg-destructive/20 text-destructive-foreground border-2 border-destructive"
            variant="outline"
          >
            <XCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
            <div className="flex flex-col items-start text-left">
              <div className="font-semibold text-destructive">Failure Path</div>
              <div className="text-xs text-muted-foreground font-normal">
                Execute next node when this test fails
              </div>
            </div>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
