import { describe, it, expect } from "vitest";
import { cleanupBandFor, isCleanupNode } from "@/lib/cleanupBand";
import type { Node } from "@xyflow/react";

const node = (
  id: string,
  x: number,
  y: number,
  opts: { teardown?: boolean; w?: number; h?: number } = {},
): Node => ({
  id,
  type: "testCase",
  position: { x, y },
  data: { label: id, config: opts.teardown ? { teardown: true } : {} },
  ...(opts.w !== undefined ? { measured: { width: opts.w, height: opts.h ?? 40 } } : {}),
});

describe("cleanupBandFor", () => {
  it("draws nothing when no node runs at the end", () => {
    expect(cleanupBandFor([node("a", 0, 0), node("b", 0, 100)])).toBeNull();
  });

  it("wraps the marked nodes, padded, and leaves room for the label", () => {
    const band = cleanupBandFor([
      node("plain", 0, 0),
      node("login", 100, 200, { teardown: true, w: 160, h: 40 }),
      node("delete", 100, 300, { teardown: true, w: 220, h: 40 }),
    ])!;
    // Left/top of the leftmost, topmost marked node, less padding — and more
    // padding at the top, where the label sits.
    expect(band.x).toBe(80);
    expect(band.y).toBe(172);
    // Widest marked node (100+220=320) minus left (100), plus padding both sides.
    expect(band.width).toBe(260);
    // Lowest bottom (300+40=340) minus top (200), plus top and bottom padding.
    expect(band.height).toBe(188);
  });

  it("ignores unmarked nodes however they are placed", () => {
    const withStray = cleanupBandFor([
      node("far", 5000, 5000, { w: 200, h: 40 }),
      node("login", 0, 0, { teardown: true, w: 200, h: 40 }),
    ])!;
    expect(withStray.width).toBe(240);
  });

  it("uses a fallback size until React Flow has measured", () => {
    const band = cleanupBandFor([node("login", 0, 0, { teardown: true })])!;
    expect(band.width).toBe(240); // 200 + 20 + 20
    expect(band.height).toBe(92); // 44 + 28 + 20
  });

  it("reads the flag the config panel writes", () => {
    expect(isCleanupNode(node("a", 0, 0, { teardown: true }))).toBe(true);
    expect(isCleanupNode(node("a", 0, 0))).toBe(false);
  });
});
