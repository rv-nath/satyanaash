import { describe, it, expect } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { computeGraphHash } from "./useAutoValidate";

/**
 * What the canvas re-validates for.
 *
 * The hash is the whole trigger: equal hash, no re-validation. So anything a rule reads has to
 * be in it, and anything no rule reads has to stay out — a hash that changes on every mouse
 * move would POST the graph continuously.
 */

const node = (id: string, config?: unknown, extra: Record<string, unknown> = {}): Node => ({
  id,
  type: "awaitCallback",
  position: { x: 0, y: 0 },
  data: { config, ...extra },
});

const edges: Edge[] = [{ id: "e1", source: "a", target: "b" }];

describe("what counts as a change worth re-validating", () => {
  it("notices a node's config changing", () => {
    // The regression this exists for. Config used to be absent from the hash, so every
    // config-derived verdict froze at whatever it was when the node was added: setting an
    // await node's path never cleared AWAIT_WITHOUT_PATH, and fixing a poll never cleared
    // POLL_WITHOUT_UNTIL. The panel said one thing and the server another.
    const before = computeGraphHash([node("w1", { awaitCallback: { count: 1 } })], edges);
    const after = computeGraphHash(
      [node("w1", { awaitCallback: { count: 1, path: "dr/x" } })],
      edges,
    );
    expect(after).not.toBe(before);
  });

  it("notices config being cleared as well as set", () => {
    const withConfig = computeGraphHash([node("w1", { check: "response.status == 200" })], edges);
    const without = computeGraphHash([node("w1", undefined)], edges);
    expect(without).not.toBe(withConfig);
  });

  it("ignores a node being dragged, which no rule reads", () => {
    // A hash that moved with the cursor would POST the graph continuously.
    const here = computeGraphHash([node("w1", { awaitCallback: { path: "dr/x" } })], edges);
    const moved = computeGraphHash(
      [{ ...node("w1", { awaitCallback: { path: "dr/x" } }), position: { x: 900, y: 400 } }],
      edges,
    );
    expect(moved).toBe(here);
  });

  it("ignores the order nodes happen to arrive in", () => {
    // Nodes are sorted by id, so a re-ordered array is the same graph.
    const one = computeGraphHash([node("a"), node("b")], edges);
    const other = computeGraphHash([node("b"), node("a")], edges);
    expect(other).toBe(one);
  });

  it("still notices the structural changes it always did", () => {
    const before = computeGraphHash([node("a")], edges);
    expect(computeGraphHash([node("a"), node("b")], edges)).not.toBe(before);
    expect(
      computeGraphHash([node("a")], [{ id: "e1", source: "a", target: "c" }]),
    ).not.toBe(before);
    expect(computeGraphHash([{ ...node("a"), type: "testCase" }], edges)).not.toBe(before);
  });

  it("notices which test case a node points at", () => {
    const before = computeGraphHash([node("a", undefined, { testCaseId: "t1" })], edges);
    const after = computeGraphHash([node("a", undefined, { testCaseId: "t2" })], edges);
    expect(after).not.toBe(before);
  });
});
