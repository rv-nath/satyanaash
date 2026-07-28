import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { Node, Edge } from "@xyflow/react";

const mutateAsync = vi.fn();
vi.mock("@/hooks/useApi", () => ({
  useUpdateFlowGraph: () => ({ mutateAsync }),
}));

import { useAutoSave } from "@/hooks/useAutoSave";

const node = (id: string, label: string): Node => ({
  id,
  type: "testCase",
  position: { x: 0, y: 0 },
  data: { label },
});

const edges: Edge[] = [];

function setup(nodes: Node[]) {
  return renderHook(
    ({ nodes }: { nodes: Node[] }) =>
      useAutoSave({ flowId: "f1", version: 1, nodes, edges, debounceMs: 10 }),
    { initialProps: { nodes } },
  );
}

describe("useAutoSave", () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue({ version: 2 });
    // Each test is its own session: the hook remembers which flows it has seen.
    sessionStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("saves the very first edit after a flow opens", async () => {
    // The old code discarded the first two changes while React Flow settled, and
    // recorded them as saved — so a single edit made right away was lost.
    const { rerender } = setup([node("n1", "Login")]);
    rerender({ nodes: [node("n1", "Login as PA")] });

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const sent = mutateAsync.mock.calls[0][0].data.graph_data.nodes;
    expect(sent[0].data.label).toBe("Login as PA");
  });

  it("says nothing when a re-render changes nothing", async () => {
    const nodes = [node("n1", "Login")];
    const { rerender, result } = setup(nodes);
    rerender({ nodes: [node("n1", "Login")] }); // same content, new objects

    await act(() => new Promise((r) => setTimeout(r, 40)));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
  });

  it("keeps trying after a failed save instead of forgetting the change", async () => {
    mutateAsync.mockRejectedValueOnce(new Error("409"));
    const { rerender, result } = setup([node("n1", "Login")]);

    rerender({ nodes: [node("n1", "Login as PA")] });
    await waitFor(() => expect(result.current.status).toBe("error"));

    // A later edit must send the whole current graph, not skip it as "already saved".
    mutateAsync.mockResolvedValue({ version: 2 });
    rerender({ nodes: [node("n1", "Login as PA"), node("n2", "Delete")] });
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    const sent = mutateAsync.mock.calls[1][0].data.graph_data.nodes;
    expect(sent.map((n: { data: { label: string } }) => n.data.label)).toEqual([
      "Login as PA",
      "Delete",
    ]);
  });

  it("saves an edit that was pending when the hook remounted", async () => {
    // react-refresh, strict mode, or switching flows and back all remount this hook.
    // Its refs die with it, so the baseline is rebuilt from whatever is on screen —
    // and if that includes an unsaved edit, the edit used to become the baseline and
    // vanish. Nothing on screen said so: the status read "idle".
    const first = setup([node("n1", "server value")]);
    first.rerender({ nodes: [node("n1", "my edit")] });
    first.unmount();
    mutateAsync.mockClear();

    setup([node("n1", "my edit")]);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const sent = mutateAsync.mock.calls[0][0].data.graph_data.nodes;
    expect(sent[0].data.label).toBe("my edit");
  });

  it("doesn't write anything merely because a flow was opened", async () => {
    setup([node("n1", "server value")]);
    await act(() => new Promise((r) => setTimeout(r, 40)));
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("reports whether the graph reached the server", async () => {
    const { result, rerender } = setup([node("n1", "Login")]);
    rerender({ nodes: [node("n1", "Renamed")] });
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());

    mutateAsync.mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      expect(await result.current.save()).toBe(false);
    });
    mutateAsync.mockResolvedValue({ version: 3 });
    await act(async () => {
      expect(await result.current.save()).toBe(true);
    });
  });
});
