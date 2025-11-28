import { Settings, Sparkles, Undo2, Redo2, AlignHorizontalJustifyCenter, AlignVerticalJustifyCenter, AlignStartVertical, AlignEndVertical, AlignStartHorizontal, AlignEndHorizontal, Spline, Minus, ArrowRightToLine } from "lucide-react";
import { useTestProject } from "@/contexts/TestProjectContext";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

interface CanvasSettingsProps {
  onAutoLayout?: () => void;
}

export const CanvasSettings = ({ onAutoLayout }: CanvasSettingsProps) => {
  const { showEdgeLabels, setShowEdgeLabels, showConsole, setShowConsole, snapToGrid, setSnapToGrid, edgeType, setEdgeType, alignNodes, undo, redo, canUndo, canRedo } = useTestProject();

  return (
    <div className="absolute top-4 right-4 z-10">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" className="bg-card">
            <Settings className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>View Options</DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={showEdgeLabels}
            onCheckedChange={setShowEdgeLabels}
          >
            Show Edge Labels
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={showConsole}
            onCheckedChange={setShowConsole}
          >
            Show Console
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={snapToGrid}
            onCheckedChange={setSnapToGrid}
          >
            Snap to Grid (20px)
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Connector Style</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={edgeType} onValueChange={(value) => setEdgeType(value as any)}>
            <DropdownMenuRadioItem value="default">
              <Spline className="h-4 w-4 mr-2" />
              Curved
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="straight">
              <Minus className="h-4 w-4 mr-2" />
              Straight
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="step">
              <ArrowRightToLine className="h-4 w-4 mr-2" />
              L-Shaped
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="smoothstep">
              <ArrowRightToLine className="h-4 w-4 mr-2" />
              L-Shaped Rounded
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Edit</DropdownMenuLabel>
          <DropdownMenuItem onClick={undo} disabled={!canUndo}>
            <Undo2 className="h-4 w-4 mr-2" />
            Undo (Ctrl+Z)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={redo} disabled={!canRedo}>
            <Redo2 className="h-4 w-4 mr-2" />
            Redo (Ctrl+Y)
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Alignment</DropdownMenuLabel>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <AlignStartHorizontal className="h-4 w-4 mr-2" />
              Align Nodes
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={() => alignNodes('left')}>
                <AlignStartVertical className="h-4 w-4 mr-2" />
                Align Left
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => alignNodes('right')}>
                <AlignEndVertical className="h-4 w-4 mr-2" />
                Align Right
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => alignNodes('top')}>
                <AlignStartHorizontal className="h-4 w-4 mr-2" />
                Align Top
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => alignNodes('bottom')}>
                <AlignEndHorizontal className="h-4 w-4 mr-2" />
                Align Bottom
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => alignNodes('center-h')}>
                <AlignVerticalJustifyCenter className="h-4 w-4 mr-2" />
                Center Horizontally
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => alignNodes('center-v')}>
                <AlignHorizontalJustifyCenter className="h-4 w-4 mr-2" />
                Center Vertically
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => alignNodes('distribute-h')}>
                Distribute Horizontally
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => alignNodes('distribute-v')}>
                Distribute Vertically
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onAutoLayout}>
            <Sparkles className="h-4 w-4 mr-2" />
            Auto Layout
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
