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
 * Convert React Flow edges to API format
 */
export function edgesToApi(edges: Edge[]): FlowEdge[] {
  return edges.map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    edge_type: edge.data?.type as 'success' | 'failure' | 'default' | undefined,
    label: edge.label as string | undefined,
  }));
}
