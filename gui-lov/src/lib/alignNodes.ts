/**
 * Aligning and evenly spacing a selection.
 *
 * A node's `position` is its **top-left corner**, so working in positions alone only
 * ever lines up left and top edges. That was the bug behind "Align Horizontal Centers
 * actually aligns left": it averaged the origins and gave every node the same `x`,
 * which is a left-align at a different place. Right and bottom had the same fault in
 * milder form — they lined up the leading edge, so a wide node and a narrow one ended
 * up staggered.
 *
 * Everything here therefore works in edges and centres, and takes node size into
 * account. Kept out of the context so it can be tested with plain numbers.
 */
import type { Node, XYPosition } from "@xyflow/react";

export type AlignDirection =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "center-h"
  | "center-v"
  | "distribute-h"
  | "distribute-v";

// React Flow measures a node after its first render. Before that — a node dropped and
// aligned in the same breath — fall back to the typical size of a test node.
const DEFAULT_WIDTH = 180;
const DEFAULT_HEIGHT = 40;

export const widthOf = (n: Node): number => n.measured?.width ?? n.width ?? DEFAULT_WIDTH;
export const heightOf = (n: Node): number => n.measured?.height ?? n.height ?? DEFAULT_HEIGHT;

/** How many nodes an operation needs before it means anything: distributing needs a
 *  middle to move, aligning only needs something to align to. */
export const minimumNodes = (direction: AlignDirection): number =>
  direction.startsWith("distribute") ? 3 : 2;

/**
 * Where the selection should end up, keyed by node id.
 *
 * Every selected node gets an entry, whether or not it moved — the caller applies the
 * lot, and "did this one move" is not a question worth answering twice.
 */
export function alignedPositions(
  selected: Node[],
  direction: AlignDirection,
): Record<string, XYPosition> {
  const out: Record<string, XYPosition> = {};
  // Whole pixels: a centred node lands on a half otherwise, and a graph of nodes
  // sitting on fractional pixels renders faintly blurred.
  const put = (n: Node, xy: Partial<XYPosition>) => {
    const next = { ...n.position, ...xy };
    out[n.id] = { x: Math.round(next.x), y: Math.round(next.y) };
  };

  const left = () => Math.min(...selected.map((n) => n.position.x));
  const right = () => Math.max(...selected.map((n) => n.position.x + widthOf(n)));
  const top = () => Math.min(...selected.map((n) => n.position.y));
  const bottom = () => Math.max(...selected.map((n) => n.position.y + heightOf(n)));

  switch (direction) {
    case "left": {
      const x = left();
      selected.forEach((n) => put(n, { x }));
      break;
    }
    case "right": {
      // Right edges flush, so each node moves back by its own width.
      const edge = right();
      selected.forEach((n) => put(n, { x: edge - widthOf(n) }));
      break;
    }
    case "top": {
      const y = top();
      selected.forEach((n) => put(n, { y }));
      break;
    }
    case "bottom": {
      const edge = bottom();
      selected.forEach((n) => put(n, { y: edge - heightOf(n) }));
      break;
    }
    case "center-h": {
      // The middle of the selection's bounding box — the same reference Align Left
      // uses for its left edge. An average of the nodes' own centres would drift
      // towards whichever side happens to hold more of them.
      const centre = (left() + right()) / 2;
      selected.forEach((n) => put(n, { x: centre - widthOf(n) / 2 }));
      break;
    }
    case "center-v": {
      const centre = (top() + bottom()) / 2;
      selected.forEach((n) => put(n, { y: centre - heightOf(n) / 2 }));
      break;
    }
    case "distribute-h":
    case "distribute-v": {
      // Equalise the *gaps between nodes*, not the gaps between their origins —
      // nodes differ in size, so evenly spacing origins looks uneven.
      const horizontal = direction === "distribute-h";
      const sizeOf = (n: Node) => (horizontal ? widthOf(n) : heightOf(n));
      const posOf = (n: Node) => (horizontal ? n.position.x : n.position.y);

      const sorted = [...selected].sort((a, b) => posOf(a) - posOf(b));
      const last = sorted[sorted.length - 1];
      const spanStart = posOf(sorted[0]);
      const spanEnd = posOf(last) + sizeOf(last);
      const occupied = sorted.reduce((sum, n) => sum + sizeOf(n), 0);
      const gap = (spanEnd - spanStart - occupied) / (sorted.length - 1);

      // First and last stay put; everything between is re-spaced evenly.
      let cursor = spanStart;
      sorted.forEach((node) => {
        put(node, horizontal ? { x: cursor } : { y: cursor });
        cursor += sizeOf(node) + gap;
      });
      break;
    }
  }

  return out;
}
