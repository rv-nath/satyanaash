/**
 * Auto-save hook for flow graph changes
 *
 * Debounces changes and persists to backend after user stops editing.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { Node, Edge } from '@xyflow/react';
import { useUpdateFlowGraph } from './useApi';
import type { FlowNode, FlowEdge } from '@/lib/api/types';

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

interface UseAutoSaveOptions {
  flowId: string | null;
  version: number;
  nodes: Node[];
  edges: Edge[];
  debounceMs?: number;
  enabled?: boolean;
  onVersionUpdate?: (newVersion: number) => void;
}

interface UseAutoSaveReturn {
  status: SaveStatus;
  lastSaved: Date | null;
  error: string | null;
  save: () => Promise<void>;  // Manual save trigger
}

/**
 * Convert React Flow nodes to API format
 */
function nodesToApi(nodes: Node[]): FlowNode[] {
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
function edgesToApi(edges: Edge[]): FlowEdge[] {
  return edges.map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    edge_type: edge.data?.type as 'success' | 'failure' | 'default' | undefined,
    label: edge.label as string | undefined,
  }));
}

/**
 * Deep compare two values (simple implementation for nodes/edges)
 */
function hasChanges(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

export function useAutoSave({
  flowId,
  version,
  nodes,
  edges,
  debounceMs = 2000,
  enabled = true,
  onVersionUpdate,
}: UseAutoSaveOptions): UseAutoSaveReturn {
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const updateGraphMutation = useUpdateFlowGraph();

  // Track previous values to detect changes
  const prevNodesRef = useRef<string>('');
  const prevEdgesRef = useRef<string>('');
  const currentVersionRef = useRef(version);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true);
  const isInitializedRef = useRef(false);
  const skipCountRef = useRef(0); // Skip first few renders after init (React Flow measures nodes)

  // Update version ref when it changes
  useEffect(() => {
    currentVersionRef.current = version;
  }, [version]);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // Core save function
  const performSave = useCallback(async () => {
    if (!flowId || !isMountedRef.current) return;

    setStatus('saving');
    setError(null);

    try {
      const apiNodes = nodesToApi(nodes);
      const apiEdges = edgesToApi(edges);

      const result = await updateGraphMutation.mutateAsync({
        id: flowId,
        data: {
          graph_data: { nodes: apiNodes, edges: apiEdges },
          version: currentVersionRef.current,
        },
      });

      if (isMountedRef.current) {
        setStatus('saved');
        setLastSaved(new Date());

        // Update version for next save (optimistic locking)
        if (result.version && onVersionUpdate) {
          onVersionUpdate(result.version);
          currentVersionRef.current = result.version;
        }

        // Reset to idle after showing "saved" briefly
        setTimeout(() => {
          if (isMountedRef.current) {
            setStatus('idle');
          }
        }, 2000);
      }
    } catch (err) {
      if (isMountedRef.current) {
        const message = err instanceof Error ? err.message : 'Failed to save';
        setError(message);
        setStatus('error');
        console.error('[AutoSave] Save failed:', err);
      }
    }
  }, [flowId, nodes, edges, updateGraphMutation, onVersionUpdate]);

  // Watch for changes and trigger debounced save
  useEffect(() => {
    if (!enabled || !flowId) return;

    const nodesJson = JSON.stringify(nodesToApi(nodes));
    const edgesJson = JSON.stringify(edgesToApi(edges));

    // First time seeing data - just initialize refs, don't save
    if (!isInitializedRef.current) {
      if (nodes.length > 0) {
        prevNodesRef.current = nodesJson;
        prevEdgesRef.current = edgesJson;
        isInitializedRef.current = true;
        skipCountRef.current = 2; // Skip next 2 renders (React Flow measures nodes)
        console.log('[AutoSave] Initialized with', nodes.length, 'nodes, skipping next 2 changes');
      }
      return;
    }

    // Check if anything changed from last known state
    const nodesChanged = hasChanges(nodesJson, prevNodesRef.current);
    const edgesChanged = hasChanges(edgesJson, prevEdgesRef.current);

    if (!nodesChanged && !edgesChanged) return;

    // Update refs to current state
    prevNodesRef.current = nodesJson;
    prevEdgesRef.current = edgesJson;

    // Skip initial changes from React Flow measuring nodes
    if (skipCountRef.current > 0) {
      skipCountRef.current--;
      console.log('[AutoSave] Skipping initial change, remaining:', skipCountRef.current);
      return;
    }

    console.log('[AutoSave] User change detected - nodes:', nodesChanged, 'edges:', edgesChanged);

    // Clear existing timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // Set pending status immediately
    setStatus('pending');

    // Schedule save
    debounceTimerRef.current = setTimeout(() => {
      console.log('[AutoSave] Debounce timer fired, saving...');
      performSave();
    }, debounceMs);

  }, [nodes, edges, flowId, enabled, debounceMs, performSave]);

  // Reset initialization when flow changes
  useEffect(() => {
    isInitializedRef.current = false;
    skipCountRef.current = 0;
    prevNodesRef.current = '';
    prevEdgesRef.current = '';
  }, [flowId]);

  return {
    status,
    lastSaved,
    error,
    save: performSave,
  };
}
