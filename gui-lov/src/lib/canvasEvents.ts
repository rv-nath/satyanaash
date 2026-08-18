/**
 * Which part of the canvas an event came from.
 *
 * Exists because of a bug with no other home: React Flow calls `onEdgeContextMenu` on the edge,
 * and the same event then **bubbles** to the container's `onContextMenu`. Both set the context
 * menu, the container's runs last, and it does not know about the edge — so right-clicking an edge
 * opened the canvas menu, and the edge menu that had just been opened was overwritten a moment
 * later. Invisible in the code, because each handler is correct on its own.
 *
 * `stopPropagation` on the edge handler fixes it, but only as long as the two run in that order.
 * This is the part that does not depend on order: the container handler asks where the click came
 * from and declines the ones that belong to an edge. Pure, so it can be tested without rendering a
 * canvas — `TestCanvas` has no test file, which is why the guard lives here rather than in it.
 */

/** React Flow's own class on an edge's interaction group. */
const EDGE_CLASS = ".react-flow__edge";

/**
 * Did this event originate on an edge rather than on empty canvas?
 *
 * `closest` rather than an equality check, because the target is the `<path>` inside the edge
 * group, never the group itself.
 */
export function isEdgeEvent(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(EDGE_CLASS) !== null;
}
