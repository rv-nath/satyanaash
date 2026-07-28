/**
 * The tinted region drawn around the nodes that run after the flow.
 *
 * It follows wherever the author put those nodes — it never moves them. Kept out of
 * the canvas component so the arithmetic can be checked without mounting React Flow.
 */
import type { Node } from "@xyflow/react";

export interface Band {
  x: number;
  y: number;
  width: number;
  height: number;
}

const PAD_X = 20;
const PAD_TOP = 28; // room for the label
const PAD_BOTTOM = 20;
/** Only used for the frame before React Flow has measured a node. */
const FALLBACK_W = 200;
const FALLBACK_H = 44;

export const isCleanupNode = (node: Node): boolean =>
  (node.data?.config as { teardown?: boolean } | undefined)?.teardown === true;

export function cleanupBandFor(nodes: Node[]): Band | null {
  const marked = nodes.filter(isCleanupNode);
  if (marked.length === 0) return null;

  const left = Math.min(...marked.map((n) => n.position.x));
  const top = Math.min(...marked.map((n) => n.position.y));
  const right = Math.max(
    ...marked.map((n) => n.position.x + (n.measured?.width ?? n.width ?? FALLBACK_W)),
  );
  const bottom = Math.max(
    ...marked.map((n) => n.position.y + (n.measured?.height ?? n.height ?? FALLBACK_H)),
  );

  return {
    x: left - PAD_X,
    y: top - PAD_TOP,
    width: right - left + PAD_X * 2,
    height: bottom - top + PAD_TOP + PAD_BOTTOM,
  };
}
