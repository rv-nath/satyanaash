import { describe, it, expect } from "vitest";
import { droppedNode } from "@/lib/dropPayload";

/**
 * What the canvas makes of a drag.
 *
 * Each case here is a payload some rail actually sends. The flow one is the reason this is a
 * function at all: it arrived without `data`, `addNodeToCanvas` threw on it, the catch logged
 * only the error, and dragging a flow onto the canvas silently did nothing.
 */
describe("reading a drag onto the canvas", () => {
  it("makes a sub-flow node out of a flow, which the rail calls something else", () => {
    expect(
      droppedNode(
        JSON.stringify({
          type: "flow",
          flowId: "f1",
          data: { flowId: "f1", label: "Onboard an enterprise" },
        }),
      ),
    ).toEqual({ type: "group", data: { flowId: "f1", label: "Onboard an enterprise" } });
  });

  it("takes a test case as it comes", () => {
    expect(
      droppedNode(JSON.stringify({ type: "testCase", testCaseId: "t1", data: { testCaseId: "t1" } })),
    ).toEqual({ type: "testCase", data: { testCaseId: "t1" } });
  });

  it("takes a step from the palette", () => {
    const payload = { type: "awaitCallback", data: { label: "Await callback" } };
    expect(droppedNode(JSON.stringify(payload))).toEqual(payload);
  });

  it("refuses a payload with no data, rather than throwing inside a catch nobody reads", () => {
    expect(droppedNode(JSON.stringify({ type: "flow", flowId: "f1" }))).toBeNull();
  });

  it("refuses a node type the canvas will not create", () => {
    // A start or end node is placed once, with the flow. Dropping a second one is not a thing.
    expect(droppedNode(JSON.stringify({ type: "start", data: {} }))).toBeNull();
    expect(droppedNode(JSON.stringify({ type: "run", data: { runId: "r1" } }))).toBeNull();
  });

  it("survives a drop carrying no JSON at all", () => {
    expect(droppedNode("")).toBeNull();
    expect(droppedNode("not json")).toBeNull();
    expect(droppedNode("null")).toBeNull();
  });
});
