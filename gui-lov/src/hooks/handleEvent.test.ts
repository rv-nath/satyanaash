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
