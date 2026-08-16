import { describe, it, expect, vi } from "vitest";
import { handleEvent, type EventSink } from "./useExecutionStream";

/**
 * What one run event does to the things the canvas and console read.
 *
 * Tested against a fake sink rather than through the hook, because the interesting properties are
 * mid-run: `activeNodeId` is cleared when the stream closes, so "the node was marked active while
 * it ran" — the whole basis of the pulse on the canvas — cannot be observed from outside.
 */

const fakeSink = () => {
  const logs: string[] = [];
  const sink: EventSink = {
    addLog: (message) => logs.push(message),
    envWrites: {},
    recordResult: vi.fn(),
    setActiveNodeId: vi.fn(),
    setPausedNodeId: vi.fn(),
    setRunMode: vi.fn(),
    setExecutionId: vi.fn(),
    setTotalNodes: vi.fn(),
    subFlows: [],
    setInlined: vi.fn(),
    updateLiveRun: vi.fn(),
  };
  return { sink, logs };
};

const started = (over: Record<string, unknown> = {}) =>
  ({
    type: "node_started",
    node_id: "w1",
    node_type: "awaitCallback",
    node_label: "Chk drCallback fires",
    test_case_name: "Await callback",
    ...over,
  }) as never;

describe("a step that waits for a callback starting", () => {
  it("marks the node active, which is what pulses it on the canvas", () => {
    // The bug: the engine sent no started event for this node type at all, so a step that sits
    // for a minute left the canvas showing nothing and the run looked hung. `executionClassFor`
    // is not node-type aware, so the decoration works the moment the event arrives.
    const { sink } = fakeSink();
    handleEvent(started(), sink);
    expect(sink.setActiveNodeId).toHaveBeenCalledWith("w1");
  });

  it("says it is waiting, and names the step", () => {
    // "▶ Entering: awaitCallback node" — the old generic branch — named neither the step nor the
    // reason the run had apparently stopped.
    const { sink, logs } = fakeSink();
    handleEvent(started(), sink);
    expect(logs).toEqual(["▶ Waiting for a callback: Chk drCallback fires"]);
  });

  it("falls back to the step's own name when it has no alias", () => {
    const { sink, logs } = fakeSink();
    handleEvent(started({ node_label: undefined }), sink);
    expect(logs).toEqual(["▶ Waiting for a callback: Await callback"]);
  });

  it("does not describe it by its type, the way an unknown node is", () => {
    const { logs } = (() => {
      const f = fakeSink();
      handleEvent(started(), f.sink);
      return f;
    })();
    expect(logs.some((l) => l.includes("awaitCallback node"))).toBe(false);
    // Nor as "Running", which belongs to a step that sends something.
    expect(logs.some((l) => l.startsWith("▶ Running"))).toBe(false);
  });

  it("leaves an ordinary request step saying Running", () => {
    const { sink, logs } = fakeSink();
    handleEvent(started({ node_type: "testCase", node_label: "Send single msg" }), sink);
    expect(logs).toEqual(["▶ Running: Send single msg"]);
  });

  it("still says nothing for start and end, which are not steps", () => {
    const { sink, logs } = fakeSink();
    handleEvent(started({ node_type: "start", node_label: undefined }), sink);
    handleEvent(started({ node_type: "end", node_label: undefined }), sink);
    expect(logs).toEqual([]);
    // But they are still marked, because the canvas follows every node.
    expect(sink.setActiveNodeId).toHaveBeenCalledTimes(2);
  });
});

/**
 * A run whose canvas has a sub-flow node.
 *
 * Its steps report under ids that name no node on the canvas, so both the console and the
 * canvas need the map that comes with the `started` event — and neither may reconstruct it by
 * splitting an id.
 */
const SEP = "\u001F";
const inlined = [
  {
    group_node_id: "g1",
    flow_id: "onboarding",
    flow_name: "Onboard an enterprise",
    node_ids: [`g1${SEP}signup`],
  },
];

describe("a run that includes a sub-flow", () => {
  const startRun = (sink: EventSink) =>
    handleEvent(
      {
        type: "started",
        execution_id: "abcdef123456",
        flow_id: "f1",
        total_nodes: 3,
        inlined,
      } as never,
      sink,
    );

  it("hands the map to the canvas, which cannot decorate the node without it", () => {
    const { sink } = fakeSink();
    startRun(sink);
    expect(sink.setInlined).toHaveBeenCalledWith(inlined);
  });

  it("says which sub-flows the run pulled in, and how many steps each brought", () => {
    // The node count on the started event jumps for a reason the canvas cannot show: the
    // canvas has one box where the run has four steps.
    const { sink, logs } = fakeSink();
    startRun(sink);
    expect(logs[1]).toBe("Includes Onboard an enterprise — 1 step");
  });

  it("names the sub-flow a step came from", () => {
    // Four flows now open with the same four steps. "▶ Running: Sign Up" no longer says which.
    const { sink, logs } = fakeSink();
    startRun(sink);
    handleEvent(
      {
        type: "node_started",
        node_id: `g1${SEP}signup`,
        node_type: "testCase",
        node_label: "Sign Up",
      } as never,
      sink,
    );
    expect(logs.at(-1)).toBe("▶ Running: Onboard an enterprise \u203A Sign Up");
  });

  it("leaves the flow's own steps unprefixed", () => {
    const { sink, logs } = fakeSink();
    startRun(sink);
    handleEvent(
      { type: "node_started", node_id: "n1", node_type: "testCase", node_label: "Send" } as never,
      sink,
    );
    expect(logs.at(-1)).toBe("▶ Running: Send");
  });

  it("carries no sub-flow lines for a flow that has none", () => {
    const { sink, logs } = fakeSink();
    handleEvent(
      { type: "started", execution_id: "abcdef123456", flow_id: "f1", total_nodes: 3 } as never,
      sink,
    );
    expect(logs).toHaveLength(1);
    expect(sink.setInlined).toHaveBeenCalledWith([]);
  });
});
