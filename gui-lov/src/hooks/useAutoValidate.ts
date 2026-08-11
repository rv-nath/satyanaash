/**
 * Auto-validate hook for flow graph changes
 *
 * Validates on flow switch, and after any change a rule could have an opinion about
 * (debounced) — the graph's shape *and* each node's config. Not on positions or visual
 * settings, which no rule reads.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { Node, Edge } from '@xyflow/react';
import { useValidateFlow } from './useApi';
import { nodesToApi, edgesToApi } from '@/lib/graphUtils';
import type { ValidationIssue } from '@/lib/api/types';

export type ValidationStatus = 'idle' | 'validating' | 'valid' | 'invalid';

interface UseAutoValidateOptions {
  flowId: string | null;
  nodes: Node[];
  edges: Edge[];
  debounceMs?: number;
  enabled?: boolean;
}

interface UseAutoValidateReturn {
  status: ValidationStatus;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  lastValidated: Date | null;
  validate: () => Promise<void>;
  invalidNodeIds: Set<string>;
}

/**
 * What counts as a change worth re-validating for.
 *
 * Positions and visual settings are excluded because no rule reads them. **Config is
 * included, and used not to be** — which meant every config-derived verdict froze at
 * whatever it was when the node was last added or moved between nodes. Fixing a
 * `POLL_WITHOUT_UNTIL` never cleared it; an await node, which is always dropped with no
 * path and so always starts on an error, showed a stale `AWAIT_WITHOUT_PATH` until the
 * author switched flows and came back. The panel said one thing and the server another.
 *
 * A spurious re-validation from key order in the stringified config is harmless — it is
 * debounced, and one extra POST is cheaper than a wrong verdict left on screen.
 */
export function computeGraphHash(nodes: Node[], edges: Edge[]): string {
  // Include node IDs, types, and test case/flow references
  const nodeData = nodes.map(n => ({
    id: n.id,
    type: n.type,
    testCaseId: n.data?.testCaseId,
    flowId: n.data?.flowId,
    config: n.data?.config,
  })).sort((a, b) => a.id.localeCompare(b.id));

  // Include edge connections (source/target)
  const edgeData = edges.map(e => ({
    source: e.source,
    target: e.target,
  })).sort((a, b) => `${a.source}-${a.target}`.localeCompare(`${b.source}-${b.target}`));

  return JSON.stringify({ nodes: nodeData, edges: edgeData });
}

export function useAutoValidate({
  flowId,
  nodes,
  edges,
  debounceMs = 3000,
  enabled = true,
}: UseAutoValidateOptions): UseAutoValidateReturn {
  const [status, setStatus] = useState<ValidationStatus>('idle');
  const [errors, setErrors] = useState<ValidationIssue[]>([]);
  const [warnings, setWarnings] = useState<ValidationIssue[]>([]);
  const [lastValidated, setLastValidated] = useState<Date | null>(null);

  const validateFlowMutation = useValidateFlow();

  const prevGraphHashRef = useRef<string>('');
  const prevFlowIdRef = useRef<string | null>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true);
  const isValidatingRef = useRef(false);

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

  // Core validation function
  const performValidation = useCallback(async () => {
    if (!flowId || !isMountedRef.current) return;

    // Guard against concurrent validations
    if (isValidatingRef.current) {
      console.log('[AutoValidate] Skipping - validation already in progress');
      return;
    }

    isValidatingRef.current = true;
    setStatus('validating');

    try {
      console.log('[AutoValidate] Validating flow:', flowId);
      const result = await validateFlowMutation.mutateAsync({
        id: flowId,
        data: {
          nodes: nodesToApi(nodes),
          edges: edgesToApi(edges),
        },
      });

      if (isMountedRef.current) {
        setErrors(result.errors || []);
        setWarnings(result.warnings || []);
        setLastValidated(new Date());
        setStatus(result.valid ? 'valid' : 'invalid');
        console.log('[AutoValidate] Result:', result.valid ? 'valid' : 'invalid',
          `(${result.errors?.length || 0} errors, ${result.warnings?.length || 0} warnings)`);
      }
    } catch (error) {
      console.error('[AutoValidate] Validation failed:', error);
      if (isMountedRef.current) {
        setErrors([{
          severity: 'error',
          code: 'VALIDATION_ERROR',
          message: `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }]);
        setWarnings([]);
        setStatus('invalid');
      }
    } finally {
      isValidatingRef.current = false;
    }
  }, [flowId, nodes, edges, validateFlowMutation]);

  // Watch for flow changes and structural graph changes
  useEffect(() => {
    if (!enabled || !flowId) return;

    const currentHash = computeGraphHash(nodes, edges);
    const isFlowSwitch = flowId !== prevFlowIdRef.current;
    const isStructuralChange = currentHash !== prevGraphHashRef.current;

    // Update refs
    prevFlowIdRef.current = flowId;
    prevGraphHashRef.current = currentHash;

    // No change - skip
    if (!isFlowSwitch && !isStructuralChange) return;

    // Clear existing timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    // On flow switch, validate immediately
    if (isFlowSwitch) {
      console.log('[AutoValidate] Flow switch detected, validating immediately');
      performValidation();
      return;
    }

    // On structural change, debounce validation
    console.log('[AutoValidate] Structural change detected, scheduling validation');
    debounceTimerRef.current = setTimeout(() => {
      performValidation();
    }, debounceMs);

  }, [nodes, edges, flowId, enabled, debounceMs, performValidation]);

  // Reset state when flow changes
  useEffect(() => {
    setStatus('idle');
    setErrors([]);
    setWarnings([]);
    setLastValidated(null);
    prevGraphHashRef.current = '';
  }, [flowId]);

  // Compute invalid node IDs from errors and warnings
  const invalidNodeIds = new Set<string>(
    [...errors, ...warnings]
      .filter(issue => issue.node_id)
      .map(issue => issue.node_id!)
  );

  return {
    status,
    errors,
    warnings,
    lastValidated,
    validate: performValidation,
    invalidNodeIds,
  };
}
