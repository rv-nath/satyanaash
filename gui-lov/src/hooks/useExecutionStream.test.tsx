import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useExecutionStream } from "@/hooks/useExecutionStream";

/**
 * A response whose body is the given SSE lines, delivered as one chunk per event.
 *
 * `hold` leaves the stream open once they run out, the way a real paused run does —
 * without it the stream ends immediately and the hook tidies away the very state the
 * test is trying to look at.
 */
function sseResponse(events: object[], hold = false) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (i < events.length) {
            return { done: false, value: encoder.encode(`data: ${JSON.stringify(events[i++])}\n\n`) };
          }
          if (hold) await new Promise(() => {});
          return { done: true, value: undefined };
        },
      }),
    },
  };
}

const passed = (nodeId: string, over: object = {}) => ({
  type: "node_completed",
  node_id: nodeId,
  result: {
    node_id: nodeId,
    test_case_name: nodeId,
    status: "passed",
    duration_ms: 7,
    ...over,
  },
});

describe("useExecutionStream", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("keeps every node's result, which the console used to render and discard", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "started", execution_id: "e1", flow_id: "f1", total_nodes: 2 },
          passed("na", { exports: { my_jwt: "abc" } }),
          passed("nb"),
          { type: "completed", execution_id: "e1", status: "completed", duration_ms: 9, passed: 2, failed: 0, errors: 0, skipped: 0 },
        ]),
      ),
    );

    const { result } = renderHook(() => useExecutionStream());
    await act(async () => {
      await result.current.execute("f1");
    });

    expect(Object.keys(result.current.nodeRuns.f1)).toEqual(["na", "nb"]);
    expect(result.current.nodeRuns.f1.na.exports).toEqual({ my_jwt: "abc" });
    // The results outlive the run — they are what the canvas reports afterwards.
    expect(result.current.runMode).toBe("idle");
    expect(result.current.isExecuting).toBe(false);
  });

  it("follows the run: active while a node is in flight, parked when it pauses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "started", execution_id: "e1", flow_id: "f1", total_nodes: 2 },
          { type: "node_started", node_id: "na", node_type: "testCase", test_case_name: "a" },
          passed("na"),
          { type: "paused", node_id: "nb" },
        ]),
      ),
    );

    const { result } = renderHook(() => useExecutionStream());
    await act(async () => {
      await result.current.execute("f1", { step: true });
    });

    // The stream ended, so nothing is active or parked any more…
    expect(result.current.activeNodeId).toBeNull();
    // …but what ran is still on record.
    expect(result.current.nodeRuns.f1.na.status).toBe("passed");
    expect(result.current.totalNodes).toBe(2);
  });

  it("clears the previous run's marks so last run's ticks don't linger over this one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([passed("na")])));
    const { result } = renderHook(() => useExecutionStream());
    await act(async () => {
      await result.current.execute("f1");
    });
    expect(result.current.nodeRuns.f1.na).toBeDefined();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([passed("nb")])));
    await act(async () => {
      await result.current.execute("f1");
    });
    expect(Object.keys(result.current.nodeRuns.f1)).toEqual(["nb"]);
  });

  it("a superseded run writes nothing into the run that replaced it", async () => {
    // Aborting a fetch doesn't stop the invocation that owns it. The old stream keeps
    // delivering for a moment, and its events used to land in the log the new run had
    // just cleared — which reads as "the console kept the last run's output", and puts
    // the tail of one run into the copy of another.
    let releaseOld: (() => void) | null = null;
    const encoder = new TextEncoder();
    let oldSent = false;

    const oldStream = {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (!oldSent) {
              oldSent = true;
              // Held until the test lets it go, by which time run 2 has started.
              await new Promise<void>((resolve) => { releaseOld = resolve; });
              return {
                done: false,
                value: encoder.encode(`data: ${JSON.stringify(passed("stale-node"))}\n\n`),
              };
            }
            return { done: true, value: undefined };
          },
        }),
      },
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(oldStream)
      .mockResolvedValue(sseResponse([passed("fresh-node")], true));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useExecutionStream());

    act(() => { void result.current.execute("f1"); });
    await waitFor(() => expect(releaseOld).not.toBeNull());

    // Run 2 supersedes it.
    act(() => { void result.current.execute("f1", { step: true }) });
    await waitFor(() => expect(result.current.nodeRuns.f1?.["fresh-node"]).toBeDefined());

    // Now let the abandoned stream deliver.
    await act(async () => {
      releaseOld!();
      await Promise.resolve();
    });

    expect(result.current.nodeRuns.f1["stale-node"]).toBeUndefined();
    const messages = (result.current.logsByFlow.f1 ?? []).map((l) => l.message);
    expect(messages.filter((m) => m.includes("stale-node"))).toEqual([]);
    // And the old invocation's `finally` hasn't reported the new run as finished.
    expect(result.current.isExecuting).toBe(true);

    act(() => result.current.cancelExecution());
  });

  it("asks the server to pause between nodes only when told to step", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useExecutionStream());

    await act(async () => {
      await result.current.execute("f1");
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).step).toBe(false);

    await act(async () => {
      await result.current.execute("f1", { step: true });
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).step).toBe(true);
  });

  it("addresses a press at the run the server told it about", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes("/step")
          ? { ok: true, status: 202 }
          : sseResponse(
              [
                { type: "started", execution_id: "run-42", flow_id: "f1", total_nodes: 1 },
                { type: "paused", node_id: "nb" },
              ],
              true, // stays parked, like the real thing
            ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useExecutionStream());
    act(() => {
      void result.current.execute("f1", { step: true });
    });
    await waitFor(() => expect(result.current.runMode).toBe("paused"));
    expect(result.current.pausedNodeId).toBe("nb");

    await act(async () => {
      await result.current.step("next");
    });

    const stepCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/step"));
    expect(stepCall?.[0]).toContain("/executions/run-42/step");
    expect(JSON.parse(stepCall![1].body)).toEqual({ command: "next" });
    // Pressing it clears the parked state at once rather than a round trip later.
    expect(result.current.pausedNodeId).toBeNull();
    expect(result.current.runMode).toBe("running");

    // Abandoning it is what closing the tab does, and must not leave the hook busy.
    act(() => result.current.cancelExecution());
    await waitFor(() => expect(result.current.isExecuting).toBe(false));
  });
});
