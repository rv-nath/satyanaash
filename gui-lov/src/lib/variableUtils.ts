import { Node, Edge } from "@xyflow/react";

/**
 * Extracts variable names from template strings like {{variableName}}
 */
export function extractVariables(text: string): string[] {
  if (!text) return [];
  const regex = /\{\{(\w+)\}\}/g;
  const matches: string[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.push(match[1]);
  }
  return [...new Set(matches)]; // Remove duplicates
}

/**
 * Extracts variables from SAT.vars usage in scripts
 */
export function extractScriptVariables(script: string): string[] {
  if (!script) return [];
  const regex = /SAT\.vars\.(\w+)/g;
  const matches: string[] = [];
  let match;
  while ((match = regex.exec(script)) !== null) {
    matches.push(match[1]);
  }
  return [...new Set(matches)];
}

/**
 * Gets all variables used in a test case
 */
export function getAllUsedVariables(testCase: {
  endpoint?: string;
  headers?: string;
  payload?: string;
  preTestScript?: string;
  postTestScript?: string;
}): string[] {
  const vars: string[] = [
    ...extractVariables(testCase.endpoint || ''),
    ...extractVariables(testCase.headers || ''),
    ...extractVariables(testCase.payload || ''),
    ...extractScriptVariables(testCase.preTestScript || ''),
    ...extractScriptVariables(testCase.postTestScript || ''),
  ];
  return [...new Set(vars)];
}

/**
 * Gets all output variables defined by upstream nodes
 */
export function getUpstreamVariables(
  currentNodeId: string,
  nodes: Node[],
  edges: Edge[]
): Array<{ name: string; nodeId: string; nodeName: string }> {
  const upstreamNodeIds = findUpstreamNodes(currentNodeId, edges);
  const variables: Array<{ name: string; nodeId: string; nodeName: string }> = [];

  upstreamNodeIds.forEach(nodeId => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    const config = node.data?.config as { outputVars?: Array<{ name: string }> } | undefined;
    const outputVars = config?.outputVars || [];
    
    outputVars.forEach(v => {
      if (v.name) {
        variables.push({
          name: v.name,
          nodeId: node.id,
          nodeName: (node.data.label as string) || node.id,
        });
      }
    });
  });

  return variables;
}

/**
 * Finds all nodes that are upstream from the given node (can reach this node)
 */
function findUpstreamNodes(nodeId: string, edges: Edge[]): string[] {
  const upstream = new Set<string>();
  const visited = new Set<string>();

  const traverse = (currentId: string) => {
    if (visited.has(currentId)) return;
    visited.add(currentId);

    edges.forEach(edge => {
      if (edge.target === currentId) {
        upstream.add(edge.source);
        traverse(edge.source);
      }
    });
  };

  traverse(nodeId);
  return Array.from(upstream);
}

/**
 * Gets all output variables defined in the entire flow
 */
export function getAllOutputVariables(nodes: Node[]): Array<{ name: string; nodeId: string; nodeName: string }> {
  const variables: Array<{ name: string; nodeId: string; nodeName: string }> = [];

  nodes.forEach(node => {
    if (node.type === 'start' || node.type === 'end') return;

    const config = node.data?.config as { outputVars?: Array<{ name: string }> } | undefined;
    const outputVars = config?.outputVars || [];
    
    outputVars.forEach(v => {
      if (v.name) {
        variables.push({
          name: v.name,
          nodeId: node.id,
          nodeName: (node.data.label as string) || node.id,
        });
      }
    });
  });

  return variables;
}
