/**
 * Auto-save hook for flow graph changes
 *
 * Debounces changes and persists to backend after user stops editing.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { Node, Edge } from '@xyflow/react';
import { useUpdateFlowGraph } from './useApi';
import { nodesToApi, edgesToApi } from '@/lib/graphUtils';
import type { EdgeSettings } from '@/contexts/TestProjectContext';

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

interface UseAutoSaveOptions {
  flowId: string | null;
  version: number;
  nodes: Node[];
  edges: Edge[];
  edgeSettings?: EdgeSettings;
  flowVariables?: Record<string, unknown>;
  debounceMs?: number;
  enabled?: boolean;
  onVersionUpdate?: (newVersion: number) => void;
}

interface UseAutoSaveReturn {
  status: SaveStatus;
  lastSaved: Date | null;
  error: string | null;
  /** Persist now, resolving true once the server has this graph. Callers that
   *  act on the saved copy — running a flow — need to know, and an auto-save
   *  that only sets an error status can't tell them. */
  save: () => Promise<boolean>;
}

/**
 * Flows this browser session has already had open, remembered outside React so a
 * remount can be told apart from a first load.
 *
 * It matters because the baseline — "what the server holds" — is taken from what is
 * on screen the first time the hook sees a flow. That is true on a genuine load and
 * false after a remount, where the screen may carry edits that never went out. Get
 * it wrong and those edits become the baseline and are never saved: the original bug
 * this hook had, arriving through a different door.
 */
const SEEN_KEY = "sat.autosave.seenFlows";

function hasSeenFlow(flowId: string): boolean {
  try {
    return (JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? "[]") as string[]).includes(flowId);
  } catch {
    return false; // Storage unavailable: treat as a first load rather than throwing.
  }
}

function markFlowSeen(flowId: string): void {
  try {
    const seen = new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? "[]") as string[]);
    seen.add(flowId);
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    // Nothing to do — the cost is one extra save, not a lost edit.
  }
}

/**
 * Deep compare two values (simple implementation for nodes/edges)
 */
function hasChanges(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

/**
 * Create a comparable representation of nodes, excluding volatile fields like width/height
 * that change when React Flow re-measures (e.g., on window focus).
 */
function nodesForComparison(nodes: Node[]): unknown[] {
  return nodes.map(node => ({
    id: node.id,
    type: node.type,
    position: { x: node.position.x, y: node.position.y },
    data: node.data,
    // Exclude: width, height (volatile - changes on window focus)
  }));
}

export function useAutoSave({
  flowId,
  version,
  nodes,
  edges,
  edgeSettings,
  flowVariables,
  debounceMs = 2000,
  enabled = true,
  onVersionUpdate,
}: UseAutoSaveOptions): UseAutoSaveReturn {
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const updateGraphMutation = useUpdateFlowGraph();

  // Track previous values to detect changes
  // What the server is believed to hold. Comparing against this rather than
  // against the previous render is what makes the check honest: any difference is
  // unsaved, whenever it appeared. The old code compared render-to-render and
  // advanced its refs before deciding whether to save, so a change it chose to
  // skip was recorded as saved and never sent again — one edit made just after
  // opening a flow disappeared, with the status still reading "idle".
  const savedStateRef = useRef<string>('');
  const currentVersionRef = useRef(version);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true);
  // Which flow savedStateRef describes. Kept here rather than in a separate reset
  // effect: that effect ran *after* this one on mount and undid its
  // initialisation, so the next edit was mistaken for first sight and dropped.
  const stateFlowRef = useRef<string | null>(null);
  // The timer calls whatever the latest save is. Depending on performSave in the
  // effect would re-run it on every render — including the re-render a failed save
  // causes, turning one rejected save into a retry every debounce interval.
  const performSaveRef = useRef<() => Promise<boolean>>(async () => false);
  // saveNow runs from a timer, so it must read the latest state rather than the
  // one captured when the timer was set.
  const fingerprintRef = useRef<() => string>(() => '');
  // A save already on its way covers the state that triggered it; a second save
  // racing it would send the same version twice and lose on optimistic locking.
  const inFlightRef = useRef<Promise<boolean> | null>(null);
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
  const saveNow = useCallback(async (): Promise<boolean> => {
    const sending = fingerprintRef.current();
    setStatus('saving');
    setError(null);

    try {
      const apiNodes = nodesToApi(nodes);
      const apiEdges = edgesToApi(edges);

      // Build canvas_settings from edgeSettings
      const canvasSettings: Record<string, unknown> = {};
      if (edgeSettings) {
        canvasSettings.edgeType = edgeSettings.edgeType;
        canvasSettings.showEdgeLabels = edgeSettings.showEdgeLabels;
        if (edgeSettings.viewport) {
          canvasSettings.viewport = edgeSettings.viewport;
        }
      }

      const result = await updateGraphMutation.mutateAsync({
        id: flowId,
        data: {
          graph_data: {
            nodes: apiNodes,
            edges: apiEdges,
            canvas_settings: canvasSettings,
            variables: flowVariables || {},
          },
          version: currentVersionRef.current,
        },
      });

      if (isMountedRef.current) {
        // Recorded only now: if the save had failed, the graph would still differ
        // from the server's copy and the next change must send it again.
        savedStateRef.current = sending;
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
      return true;
    } catch (err) {
      if (isMountedRef.current) {
        const message = err instanceof Error ? err.message : 'Failed to save';
        setError(message);
        setStatus('error');
        console.error('[AutoSave] Save failed:', err);
      }
      return false;
    }
  }, [flowId, nodes, edges, edgeSettings, flowVariables, updateGraphMutation, onVersionUpdate]);

  const performSave = useCallback(async (): Promise<boolean> => {
    if (!flowId || !isMountedRef.current) return false;
    // Join an in-flight save rather than racing it.
    if (inFlightRef.current) return inFlightRef.current;

    const promise = saveNow();
    inFlightRef.current = promise;
    try {
      return await promise;
    } finally {
      inFlightRef.current = null;
    }
  }, [flowId, saveNow]);
  performSaveRef.current = performSave;

  // One string describing everything the server stores for this flow. Used both
  // to decide whether there is anything to save and to record what a save sent.
  const fingerprint = useCallback(() => JSON.stringify({
    // Volatile fields (width/height) are excluded: React Flow re-measures on
    // window focus, and that isn't an edit.
    nodes: nodesForComparison(nodes),
    edges: edgesToApi(edges),
    edgeSettings: edgeSettings || {},
    flowVariables: flowVariables || {},
  }), [nodes, edges, edgeSettings, flowVariables]);
  fingerprintRef.current = fingerprint;

  // Watch for changes and trigger a debounced save
  useEffect(() => {
    if (!enabled || !flowId) return;

    const current = fingerprint();

    if (stateFlowRef.current !== flowId) {
      if (nodes.length === 0) return; // still loading
      stateFlowRef.current = flowId;

      if (!hasSeenFlow(flowId)) {
        // A genuine first load: what's on screen is what the server gave us.
        markFlowSeen(flowId);
        savedStateRef.current = current;
        return;
      }
      // Seen before in this session, so this is a remount and the screen may hold
      // edits that never went out. Don't adopt it — save it. A redundant write is
      // cheap; a dropped edit is not.
      savedStateRef.current = "";
    }

    // Anything that differs from the server's copy is unsaved — including a
    // change that arrived while React Flow was still settling. If the settling
    // produces the same content, this is simply equal and nothing happens.
    if (current === savedStateRef.current) return;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    setStatus('pending');
    debounceTimerRef.current = setTimeout(() => {
      performSaveRef.current();
    }, debounceMs);
  }, [fingerprint, nodes.length, flowId, enabled, debounceMs]);

  return {
    status,
    lastSaved,
    error,
    save: performSave,
  };
}
