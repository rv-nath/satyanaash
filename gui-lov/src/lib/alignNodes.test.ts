import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import type { Node } from "@xyflow/react";
import { alignedPositions, heightOf, minimumNodes, widthOf } from "@/lib/alignNodes";

/** A node at (x, y) measuring w × h. Widths differ throughout on purpose: every bug
 *  fixed here was invisible while all the nodes were the same size. */
const node = (id: string, x: number, y: number, w = 100, h = 40): Node => ({
  id,
  type: "testCase",
  position: { x, y },
  data: {},
  measured: { width: w, height: h },
});

describe("align", () => {
  // A wide node and a narrow one, so leading and trailing edges disagree.
  const wide = node("wide", 0, 0, 200, 60);
  const narrow = node("narrow", 40, 100, 80, 20);
  const pair = [wide, narrow];

  it("puts left edges flush", () => {
    const at = alignedPositions(pair, "left");
    expect(at.wide.x).toBe(0);
    expect(at.narrow.x).toBe(0);
  });

  it("puts right edges flush, not left edges at the rightmost origin", () => {
    // wide spans 0..200, narrow spans 40..120, so the right edge is 200.
    const at = alignedPositions(pair, "right");
    expect(at.wide.x + 200).toBe(200);
    expect(at.narrow.x + 80).toBe(200);
    // The old version set both x to max(origin) = 40, which left them staggered.
    expect(at.narrow.x).toBe(120);
  });

  it("puts top edges flush", () => {
    const at = alignedPositions(pair, "top");
    expect(at.wide.y).toBe(0);
    expect(at.narrow.y).toBe(0);
  });

  it("puts bottom edges flush", () => {
    // wide spans 0..60, narrow spans 100..120, so the bottom edge is 120.
    const at = alignedPositions(pair, "bottom");
    expect(at.wide.y + 60).toBe(120);
    expect(at.narrow.y + 20).toBe(120);
  });

  it("centres horizontally instead of quietly aligning left", () => {
    // The reported bug. Bounding box spans x 0..200, so the centre line is 100.
    const at = alignedPositions(pair, "center-h");
    expect(at.wide.x + 200 / 2).toBe(100);
    expect(at.narrow.x + 80 / 2).toBe(100);
    // Which means the two nodes do *not* share an x — that is what a left-align does.
    expect(at.wide.x).not.toBe(at.narrow.x);
    expect(at.wide.x).toBe(0);
    expect(at.narrow.x).toBe(60);
  });

  it("centres vertically", () => {
    // Bounding box spans y 0..120, so the centre line is 60.
    const at = alignedPositions(pair, "center-v");
    expect(at.wide.y + 60 / 2).toBe(60);
    expect(at.narrow.y + 20 / 2).toBe(60);
  });

  it("centres on the selection's middle, not on where most of the nodes are", () => {
    // Three nodes bunched left and one far right. An average of origins would sit
    // near the bunch; the bounding-box centre sits between the extremes.
    const nodes = [
      node("a", 0, 0, 100),
      node("b", 10, 50, 100),
      node("c", 20, 100, 100),
      node("d", 300, 150, 100),
    ];
    const at = alignedPositions(nodes, "center-h");
    // Box spans 0..400, so the centre is 200 and every node's centre lands there.
    for (const id of ["a", "b", "c", "d"]) {
      expect(at[id].x + 50).toBe(200);
    }
  });

  it("leaves the other axis alone", () => {
    const at = alignedPositions(pair, "left");
    expect(at.wide.y).toBe(0);
    expect(at.narrow.y).toBe(100);
  });

  it("reports a position for every node in the selection", () => {
    expect(Object.keys(alignedPositions(pair, "center-h")).sort()).toEqual(["narrow", "wide"]);
  });
});

describe("distribute", () => {
  it("equalises the gaps between nodes, not between their origins", () => {
    // 40 wide at 0, 100 wide somewhere in the middle, 60 wide ending at 400.
    const nodes = [node("a", 0, 0, 40), node("b", 90, 0, 100), node("c", 340, 0, 60)];
    const at = alignedPositions(nodes, "distribute-h");

    // First and last stay put.
    expect(at.a.x).toBe(0);
    expect(at.c.x).toBe(340);
    // Span 0..400 holds 200 of node, so 200 of gap over two gaps: 100 each.
    expect(at.b.x).toBe(140); // 0 + 40 + 100
    expect(at.b.x - (at.a.x + 40)).toBe(100);
    expect(at.c.x - (at.b.x + 100)).toBe(100);
  });

  it("distributes vertically the same way", () => {
    const nodes = [node("a", 0, 0, 100, 20), node("b", 0, 30, 100, 60), node("c", 0, 200, 100, 40)];
    const at = alignedPositions(nodes, "distribute-v");
    expect(at.a.y).toBe(0);
    expect(at.c.y).toBe(200);
    // Span 0..240 holds 120 of node, so 120 over two gaps: 60 each.
    expect(at.b.y).toBe(80); // 0 + 20 + 60
  });

  it("works from wherever the nodes happen to be, not the order they were selected", () => {
    const nodes = [node("c", 340, 0, 60), node("a", 0, 0, 40), node("b", 90, 0, 100)];
    const at = alignedPositions(nodes, "distribute-h");
    expect(at.a.x).toBe(0);
    expect(at.b.x).toBe(140);
    expect(at.c.x).toBe(340);
  });
});

describe("node size", () => {
  it("prefers what React Flow measured", () => {
    expect(widthOf(node("a", 0, 0, 123, 45))).toBe(123);
    expect(heightOf(node("a", 0, 0, 123, 45))).toBe(45);
  });

  it("falls back for a node that hasn't been rendered yet", () => {
    // Dropped and aligned in the same breath: measurement hasn't happened.
    const fresh = { id: "a", type: "testCase", position: { x: 0, y: 0 }, data: {} } as Node;
    expect(widthOf(fresh)).toBe(180);
    expect(heightOf(fresh)).toBe(40);
    // And an author-set width beats the fallback.
    expect(widthOf({ ...fresh, width: 250 })).toBe(250);
  });

  it("rounds, so a centred node doesn't land on half a pixel", () => {
    // Box spans 0..101, centre 50.5, node 40 wide → 30.5 before rounding.
    const nodes = [node("a", 0, 0, 101, 40), node("b", 0, 60, 40, 40)];
    expect(alignedPositions(nodes, "center-h").b.x).toBe(31);
  });
});

describe("minimumNodes", () => {
  it("needs three to distribute and two to align", () => {
    expect(minimumNodes("distribute-h")).toBe(3);
    expect(minimumNodes("distribute-v")).toBe(3);
    expect(minimumNodes("center-h")).toBe(2);
    expect(minimumNodes("left")).toBe(2);
  });
});

/**
 * What keeps an alignment once it is made.
 *
 * The arithmetic above is only half of it. An author reported alignment "getting lost
 * frequently", and it was: React Flow's default drag threshold is 1px, so an ordinary click
 * moved the node. Measured in a browser, 3px of hand-tremor shifted a node from x=300 to
 * x=300.816 — off the column, and onto a fractional pixel this file rounds away everywhere else.
 *
 * Read off the source because it is a prop on a component no unit test mounts; the alternative
 * is a rule nothing checks, which is how it would quietly go back to 1.
 */
describe("the canvas keeps an alignment", () => {
  const canvas = readFileSync(resolve(process.cwd(), "src/components/TestCanvas.tsx"), "utf8");

  it("does not treat a click with a tremor in it as a drag", () => {
    const threshold = Number(/nodeDragThreshold=\{(\d+)\}/.exec(canvas)?.[1]);
    expect(threshold).toBeGreaterThanOrEqual(4);
  });

  it("lands a dragged node on a whole pixel, as alignment does", () => {
    expect(canvas).toMatch(/onNodeDragStop=\{handleNodeDragStop\}/);
    expect(canvas).toMatch(/Math\.round\(n\.position\.x\)/);
  });
});
