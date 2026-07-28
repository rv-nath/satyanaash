/**
 * Hook for real-time execution streaming via Server-Sent Events (SSE)
 *
 * Features:
 * - Streams execution events in real-time as tests run
 * - AbortController to cancel previous stream when starting new execution
 * - Parses SSE data lines and dispatches to appropriate log types
 */

import { useState, useCallback, useRef } from 'react';
import { API_URL } from '@/lib/api/client';
import type { TestCaseExecutionResult } from '@/lib/api/types';
import type { ConsoleLogDetail } from '@/lib/consoleDetails';
import { fanOutDetails, resultDetails, resultHeadline } from '@/lib/consoleDetails';

/** One node's result off the wire. The single definition lives in lib/api/types —
 *  this module used to keep its own copy, which is exactly why per-row results were
 *  silently dropped from the console. */
type NodeResult = TestCaseExecutionResult;

/** Matches backend ExecutionEvent variants */
interface ExecutionEventStarted {
  type: 'started';
  execution_id: string;
  flow_id: string;
  total_nodes: number;
}

/**
 * What to call a node in the log. The author's name for it wins: two nodes can
 * share one test case in different roles, and "Login" twice says nothing about
 * which one you are reading. Falls back to the test case, then to raw ids.
 */
export function nodeName(n: {
  node_label?: string;
  test_case_name?: string;
  test_case_id?: string;
  node_id: string;
}): string {
  return n.node_label?.trim() || n.test_case_name || n.test_case_id || n.node_id;
}

interface ExecutionEventNodeStarted {
  type: 'node_started';
  node_id: string;
  node_type: string;
  node_label?: string;
  test_case_id?: string;
  test_case_name?: string;
}

interface ExecutionEventNodeCompleted {
  type: 'node_completed';
  node_id: string;
  result: NodeResult;
}

interface ExecutionEventCompleted {
  type: 'completed';
  execution_id: string;
  status: string;
  duration_ms: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
}

interface ExecutionEventError {
  type: 'error';
  message: string;
}

type ExecutionEvent =
  | ExecutionEventStarted
  | ExecutionEventNodeStarted
  | ExecutionEventNodeCompleted
  | ExecutionEventCompleted
  | ExecutionEventError;

// Defined alongside the formatters that build them; re-exported here because the
// console panel has always imported it from this module.
export type { ConsoleLogDetail } from '@/lib/consoleDetails';

export interface ConsoleLog {
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'error';
  details?: ConsoleLogDetail[];
}

export interface ExecuteFlowRequest {
  debug_mode?: boolean;
  environment?: Record<string, unknown>;
  variables?: Record<string, unknown>;
}

interface UseExecutionStreamOptions {
  /** Called once per run with the SAT.env writes made by any node, so a flow run
   *  persists them to the active environment just like a standalone run does. */
  onEnvWrites?: (writes: Record<string, unknown>) => void;
}

export function useExecutionStream({ onEnvWrites }: UseExecutionStreamOptions = {}) {
  // Logs are kept per flow. One shared list mixed unrelated runs together, so
  // switching flows meant reading someone else's failures — and a second run
  // buried the first.
  const [logsByFlow, setLogsByFlow] = useState<Record<string, ConsoleLog[]>>({});
  const [executingFlowId, setExecutingFlowId] = useState<string | null>(null);

  // Which flow the events arriving right now belong to. A ref because addLog is
  // called from the stream loop, long after the state that started it.
  const targetFlowRef = useRef<string | null>(null);

  // Store AbortController to cancel previous stream
  const abortControllerRef = useRef<AbortController | null>(null);

  // Held in a ref so `execute` stays stable as the callback's identity changes.
  const onEnvWritesRef = useRef(onEnvWrites);
  onEnvWritesRef.current = onEnvWrites;

  const addLog = useCallback((message: string, type: ConsoleLog['type'] = 'info', details?: ConsoleLogDetail[]) => {
    const flowId = targetFlowRef.current;
    if (!flowId) return;
    const entry: ConsoleLog = {
      timestamp: new Date().toISOString(),
      message,
      type,
      ...(details && { details }),
    };
    setLogsByFlow(prev => ({ ...prev, [flowId]: [...(prev[flowId] ?? []), entry] }));
  }, []);

  /** Empty one flow's console, keeping its tab. */
  const clearLogs = useCallback((flowId: string) => {
    setLogsByFlow(prev => ({ ...prev, [flowId]: [] }));
  }, []);

  /** Drop one flow's console entirely — closing its tab. */
  const closeLogs = useCallback((flowId: string) => {
    setLogsByFlow(prev => {
      const next = { ...prev };
      delete next[flowId];
      return next;
    });
  }, []);

  const cancelExecution = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setExecutingFlowId(null);
      addLog('Execution cancelled', 'info');
    }
  }, [addLog]);

  const execute = useCallback(async (flowId: string, options: ExecuteFlowRequest = {}) => {
    // Cancel any previous execution
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Create new AbortController for this execution
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // Everything logged from here belongs to this flow.
    targetFlowRef.current = flowId;
    setExecutingFlowId(flowId);
    // A re-run replaces the previous one rather than appending to it.
    setLogsByFlow(prev => ({ ...prev, [flowId]: [] }));
    addLog(`Starting ${options.debug_mode ? 'debug' : 'test'} execution...`, 'info');

    // SAT.env writes from every node in this run. Collected as events stream in and
    // applied once at the end — one project update instead of one per node.
    const envWrites: Record<string, unknown> = {};

    try {
      const response = await fetch(`${API_URL}/flows/${flowId}/execute-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          debug_mode: options.debug_mode ?? false,
          environment: options.environment ?? {},
          variables: options.variables ?? {},
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        // Decode chunk and add to buffer
        buffer += decoder.decode(value, { stream: true });

        // Process complete lines from buffer
        const lines = buffer.split('\n');
        // Keep incomplete line in buffer
        buffer = lines.pop() || '';

        for (const line of lines) {
          // Skip empty lines and keep-alive messages
          if (!line.trim() || line.trim() === 'keep-alive') {
            continue;
          }

          // Parse SSE data lines
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6); // Remove 'data: ' prefix
            try {
              const event: ExecutionEvent = JSON.parse(jsonStr);
              handleEvent(event, addLog, options.debug_mode ?? false, envWrites);
            } catch (parseError) {
              console.warn('Failed to parse SSE event:', jsonStr, parseError);
            }
          }
        }
      }

      // Process any remaining data in buffer
      if (buffer.trim() && buffer.startsWith('data: ')) {
        const jsonStr = buffer.slice(6);
        try {
          const event: ExecutionEvent = JSON.parse(jsonStr);
          handleEvent(event, addLog, options.debug_mode ?? false, envWrites);
        } catch (parseError) {
          console.warn('Failed to parse final SSE event:', jsonStr, parseError);
        }
      }

      // Persist SAT.env writes made during the run (matches standalone behaviour).
      const written = Object.keys(envWrites);
      if (written.length > 0) {
        onEnvWritesRef.current?.(envWrites);
        addLog(`Saved ${written.length} environment variable(s): ${written.join(', ')}`, 'info');
      }

    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          // Execution was cancelled, already logged
          return;
        }
        addLog(`Error: ${error.message}`, 'error');
      } else {
        addLog('Unknown error occurred', 'error');
      }
    } finally {
      setExecutingFlowId(null);
      abortControllerRef.current = null;
    }
  }, [addLog]);

  return {
    logsByFlow,
    /** The flow currently running, if any — one execution at a time. */
    executingFlowId,
    isExecuting: executingFlowId !== null,
    execute,
    cancelExecution,
    clearLogs,
    closeLogs,
  };
}

/** Handle individual execution events */
function handleEvent(
  event: ExecutionEvent,
  addLog: (message: string, type: ConsoleLog['type'], details?: ConsoleLogDetail[]) => void,
  debugMode: boolean,
  envWrites?: Record<string, unknown>
) {
  switch (event.type) {
    case 'started':
      addLog(`Execution ${event.execution_id.slice(0, 8)}... started (${event.total_nodes} nodes)`, 'info');
      break;

    case 'node_started':
      if (event.node_type === 'testCase') {
        addLog(`▶ Running: ${nodeName(event)}`, 'info');
      } else if (event.node_type !== 'start' && event.node_type !== 'end') {
        addLog(`▶ Entering: ${event.node_type} node`, 'info');
      }
      break;

    case 'node_completed': {
      const { result } = event;
      // Collect SAT.env writes; the caller persists them once the run finishes.
      if (result.env && envWrites) {
        Object.assign(envWrites, result.env);
      }
      const logType: ConsoleLog['type'] =
        result.status === 'passed' ? 'success' :
        result.status === 'error' || result.status === 'failed' ? 'error' : 'info';

      // A node that ran once per data row reports every row: a summary line each, and
      // the full request and response for the ones that didn't pass.
      const details: ConsoleLogDetail[] = result.iterations
        ? fanOutDetails(result)
        : resultDetails(result);

      addLog(resultHeadline(result, nodeName(result)), logType, details.length > 0 ? details : undefined);
      break;
    }

    case 'completed': {
      const { passed, failed, errors, skipped, duration_ms, status } = event;
      const total = passed + failed + errors + skipped;
      const resultType: ConsoleLog['type'] = failed === 0 && errors === 0 ? 'success' : 'error';
      addLog(`Execution ${status} in ${duration_ms}ms`, 'info');
      addLog(`Results: ${passed}/${total} passed, ${failed} failed, ${errors} errors, ${skipped} skipped`, resultType);
      break;
    }

    case 'error':
      addLog(`Execution error: ${event.message}`, 'error');
      break;
  }
}
