import { Undo2, Redo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTestProject } from "@/contexts/TestProjectContext";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export const UndoRedoControls = () => {
  const { undo, redo, canUndo, canRedo, lastAction } = useTestProject();

  return (
    <TooltipProvider>
      <div className="absolute top-4 right-20 z-10 flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              onClick={undo}
              disabled={!canUndo}
              className="bg-card"
            >
              <Undo2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Undo {lastAction && `(${lastAction})`}</p>
            <p className="text-xs text-muted-foreground">Ctrl+Z</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              onClick={redo}
              disabled={!canRedo}
              className="bg-card"
            >
              <Redo2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Redo</p>
            <p className="text-xs text-muted-foreground">Ctrl+Y</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
