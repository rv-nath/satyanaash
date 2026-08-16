import type { NodeType } from "@/contexts/TestProjectContext";

/**
 * What a drag onto the canvas asks for, or nothing it can act on.
 *
 * The rails and the palette all send `{type, data}` over `application/json`, some with an extra
 * flat key their own drop targets read. Reading that used to be four inline lines inside a
 * `try`, and the catch logged only the error — so when the flows rail sent a payload with no
 * `data`, dragging a flow onto the canvas threw and did **nothing at all**, for as long as
 * sub-flow nodes have existed. Nobody could have found that from the console.
 *
 * A function, so the reading is tested rather than inferred from the fact that dragging
 * appears to work for the two payloads someone happened to try.
 */
export interface DroppedNode {
  type: NodeType;
  data: Record<string, unknown>;
}

/** Node types the canvas will create from a drag. `start`/`end` are not among them. */
const DROPPABLE: NodeType[] = ["testCase", "group", "awaitCallback"];

export function droppedNode(raw: string): DroppedNode | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const { type, data } = payload as { type?: unknown; data?: unknown };
  if (typeof type !== "string" || !data || typeof data !== "object") return null;

  // The rail calls it a flow; the canvas calls the node that runs one a group. One concept,
  // two names, and this is the only place they meet — the rename is deferred because it needs
  // a migration across every saved graph.
  const nodeType = (type === "flow" ? "group" : type) as NodeType;
  if (!DROPPABLE.includes(nodeType)) return null;
  return { type: nodeType, data: data as Record<string, unknown> };
}
