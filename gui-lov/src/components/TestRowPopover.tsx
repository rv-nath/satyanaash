import { RefObject, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  anchorRef: RefObject<HTMLElement>;
  method: string;
  endpoint: string;
  description?: string;
  open: boolean;
}

export function TestRowPopover({ anchorRef, method, endpoint, description, open }: Props) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (open && anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect();
      setPos({ left: r.right + 12, top: r.top - 6 });
    } else {
      setPos(null);
    }
  }, [open, anchorRef]);

  if (!open || !pos) return null;

  return createPortal(
    <div
      role="tooltip"
      className="fixed z-50 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-lg
                 before:absolute before:-left-1.5 before:top-3 before:h-2.5 before:w-2.5 before:rotate-45
                 before:border-b before:border-l before:border-border before:bg-popover"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase text-muted-foreground">{method}</span>
        <span className="font-mono text-foreground">{endpoint}</span>
      </div>
      {description && <div className="mt-1 text-muted-foreground">{description}</div>}
    </div>,
    document.body
  );
}
