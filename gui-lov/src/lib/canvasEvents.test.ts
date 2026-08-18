/**
 * The guard that keeps an edge's context menu from being replaced by the canvas's.
 *
 * The bug had no test because it lived in the gap between two correct handlers: React Flow calls
 * `onEdgeContextMenu`, the event bubbles, and the container's `onContextMenu` sets the canvas menu
 * over the top. Right-clicking an edge showed the canvas menu, and the edge menu was never seen.
 */
import { describe, it, expect } from "vitest";
import { isEdgeEvent } from "@/lib/canvasEvents";

const el = (html: string): Element => {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.firstElementChild!;
};

describe("isEdgeEvent", () => {
  it("recognises a click on the path inside an edge group", () => {
    // The target is the <path>, never the group — which is why this uses `closest` and not an
    // equality check.
    const group = el('<g class="react-flow__edge"><path class="react-flow__edge-path"></path></g>');
    expect(isEdgeEvent(group.querySelector("path"))).toBe(true);
  });

  it("recognises the edge group itself", () => {
    expect(isEdgeEvent(el('<g class="react-flow__edge"></g>'))).toBe(true);
  });

  it("leaves the empty canvas alone, so right-clicking it still opens the canvas menu", () => {
    expect(isEdgeEvent(el('<div class="react-flow__pane"></div>'))).toBe(false);
  });

  it("does not treat a node as an edge", () => {
    const node = el('<div class="react-flow__node"><div class="inner"></div></div>');
    expect(isEdgeEvent(node.querySelector(".inner"))).toBe(false);
  });

  it("says no to a target that is not an element at all", () => {
    expect(isEdgeEvent(null)).toBe(false);
    expect(isEdgeEvent(document.createTextNode("x") as unknown as EventTarget)).toBe(false);
  });
});
