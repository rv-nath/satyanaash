/**
 * Graph conversion utilities
 *
 * Converts between React Flow format and API format for nodes/edges.
 */

import { Node, Edge } from '@xyflow/react';
import type { FlowNode, FlowEdge } from '@/lib/api/types';

/**
 * Convert React Flow nodes to API format
 */
export function nodesToApi(nodes: Node[]): FlowNode[] {
  return nodes.map(node => ({
    id: node.id,
    type: node.type as 'start' | 'end' | 'testCase' | 'group',
    position: { x: node.position.x, y: node.position.y },
    data: node.data as Record<string, unknown>,
    width: node.measured?.width,
    height: node.measured?.height,
  }));
}

/**
 * Convert React Flow edges to API format.
 *
 * **The keys here are the wire's, not Rust's.** `GraphEdge` names the field `edge_type` in Rust
 * but carries `#[serde(rename = "type")]`, and it has no top-level `label` at all — it has a
 * `data` bag. This function sent `edge_type` and `label`, so serde ignored both: the edge saved,
 * and came back with no type and no label.
 *
 * What that cost is worth stating, because it was invisible: the canvas asks which kind of edge
 * you are drawing, colours a failure edge red and labels it — and then dropped both on save. So
 * **no failure edge drawn on the canvas has ever survived a reload**, and because
 * `useAutoValidate` sends this same shape, the validator was told those graphs had no failure
 * edge and said so. One wrong key, two symptoms that looked unrelated.
 *
 * Feeding validation as well as autosave is also why this must stay the single conversion: a
 * second one would let the two disagree about what the graph is again.
 */
export function edgesToApi(edges: Edge[]): FlowEdge[] {
  return edges.map(edge => {
    const type = edge.data?.type as 'success' | 'failure' | 'default' | undefined;
    const label = edge.label as string | undefined;
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      // Omitted rather than sent as undefined, so an untyped edge's JSON stays as it was and a
      // saved graph does not churn.
      ...(type ? { type } : {}),
      ...(label ? { data: { label } } : {}),
    };
  });
}

/**
 * Convert API edges to React Flow format.
 *
 * The inbound half of the same bug, and the reason fixing only the outbound one would have
 * looked like it worked and then lost the type on the next save: this dropped the edge's type
 * on the way *in*, so the canvas held an untyped edge whatever the server had stored.
 *
 * The type lives at `edge.data.type` on the canvas — `TestCanvas` reads it there for the stroke
 * colour, and `handleEdgeTypeSelect` writes it there when an edge is drawn — while the server
 * keeps it at the edge's root. This is the one place that translation happens.
 */
export function edgesFromApi(
  edges: FlowEdge[] | undefined,
  /** Ids that moved because a duplicate was found on load; identity if none did. */
  remap: (id: string) => string = id => id,
): Edge[] {
  return (edges ?? []).map(edge => ({
    id: edge.id,
    source: remap(edge.source),
    target: remap(edge.target),
    ...(edge.type ? { data: { type: edge.type } } : {}),
    // The canvas shows a label from React Flow's own `label` prop; the server keeps it in the
    // edge's data bag, since it has nowhere else to put it.
    ...(edge.data?.label ? { label: edge.data.label as string } : {}),
  }));
}
