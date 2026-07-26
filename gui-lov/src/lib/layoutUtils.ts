import dagre from 'dagre';
import { Node, Edge } from '@xyflow/react';

export type LayoutDirection = 'TB' | 'LR';
export type LayoutSpacing = 'comfortable' | 'compact';

// ranksep = gap between steps of the flow, nodesep = gap between siblings.
const SPACING: Record<LayoutSpacing, { ranksep: number; nodesep: number }> = {
  comfortable: { ranksep: 72, nodesep: 48 },
  compact: { ranksep: 32, nodesep: 24 },
};

// Fallbacks for nodes React Flow hasn't measured yet. Real sizes come from
// node.measured, so the layout stays correct as node designs change.
const FALLBACK_W = 180;
const FALLBACK_H = 40;

const sizeOf = (node: Node) => ({
  width: node.measured?.width ?? FALLBACK_W,
  height: node.measured?.height ?? FALLBACK_H,
});

// Every node type exposes these handle ids, so edges can be re-routed to the
// ports that face the flow direction instead of staying glued to top/bottom.
const PORTS: Record<LayoutDirection, { source: string; target: string }> = {
  TB: { source: 'source-bottom', target: 'target-top' },
  LR: { source: 'source-right', target: 'target-left' },
};

/**
 * Arrange the graph along its edges — 'TB' (top to bottom) or 'LR' (left to right).
 * Only positions change; nodes and edges are otherwise untouched.
 */
export const getLayoutedElements = (
  nodes: Node[],
  edges: Edge[],
  direction: LayoutDirection = 'TB',
  spacing: LayoutSpacing = 'comfortable'
) => {
  const { ranksep, nodesep } = SPACING[spacing];
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({
    rankdir: direction,
    nodesep,
    ranksep,
    marginx: 24,
    marginy: 24,
  });

  nodes.forEach((node) => dagreGraph.setNode(node.id, sizeOf(node)));
  edges.forEach((edge) => {
    if (edge.source && edge.target) {
      dagreGraph.setEdge(edge.source, edge.target);
    }
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const positioned = dagreGraph.node(node.id);
    if (!positioned) return node; // node isn't in the graph — leave it alone
    const { width, height } = sizeOf(node);
    // dagre reports centres; React Flow positions from the top-left corner.
    return {
      ...node,
      position: { x: positioned.x - width / 2, y: positioned.y - height / 2 },
    };
  });

  // Re-route edges to the ports facing the new direction.
  const { source, target } = PORTS[direction];
  const layoutedEdges = edges.map((edge) => ({
    ...edge,
    sourceHandle: source,
    targetHandle: target,
  }));

  return { nodes: layoutedNodes, edges: layoutedEdges };
};
