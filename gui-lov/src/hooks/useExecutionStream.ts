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

/** Matches backend ExecutionEvent variants */
interface ExecutionEventStarted {
  type: 'started';
  execution_id: string;
  flow_id: string;
  total_nodes: number;
}

interface ExecutionEventNodeStarted {
  type: 'node_started';
  node_id: string;
  node_type: string;
  test_case_id?: string;
  test_case_name?: string;
}

interface NodeResult {
  node_id: string;
  test_case_id?: string;
  test_case_name?: string;
  status: 'passed' | 'failed' | 'error' | 'skipped';
  duration_ms: number;
  request?: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
  };
  response?: {
    status: number;
    headers?: Record<string, string>;
    body?: string;
  };
  exports?: Record<string, unknown>;
  error_message?: string;
  logs: string[];
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

export interface ConsoleLogDetail {
  label: string;
  value: string;
  type?: 'info' | 'error';
}

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

export function useExecutionStream() {
  const [logs, setLogs] = useState<ConsoleLog[]>([
    { timestamp: new Date().toISOString(), message: 'Ready to execute tests', type: 'info' }
  ]);
  const [isExecuting, setIsExecuting] = useState(false);

  // Store AbortController to cancel previous stream
  const abortControllerRef = useRef<AbortController | null>(null);

  const addLog = useCallback((message: string, type: ConsoleLog['type'] = 'info', details?: ConsoleLogDetail[]) => {
    setLogs(prev => [...prev, {
      timestamp: new Date().toISOString(),
      message,
      type,
      ...(details && { details }),
    }]);
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  const cancelExecution = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsExecuting(false);
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

    setIsExecuting(true);
    addLog(`Starting ${options.debug_mode ? 'debug' : 'test'} execution...`, 'info');

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
              handleEvent(event, addLog, options.debug_mode ?? false);
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
          handleEvent(event, addLog, options.debug_mode ?? false);
        } catch (parseError) {
          console.warn('Failed to parse final SSE event:', jsonStr, parseError);
        }
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
      setIsExecuting(false);
      abortControllerRef.current = null;
    }
  }, [addLog]);

  return {
    logs,
    isExecuting,
    execute,
    cancelExecution,
    clearLogs,
  };
}

/** Handle individual execution events */
function handleEvent(
  event: ExecutionEvent,
  addLog: (message: string, type: ConsoleLog['type']) => void,
  debugMode: boolean
) {
  switch (event.type) {
    case 'started':
      addLog(`Execution ${event.execution_id.slice(0, 8)}... started (${event.total_nodes} nodes)`, 'info');
      break;

    case 'node_started':
      if (event.node_type === 'testCase') {
        addLog(`▶ Running: ${event.test_case_name || event.test_case_id || event.node_id}`, 'info');
      } else if (event.node_type !== 'start' && event.node_type !== 'end') {
        addLog(`▶ Entering: ${event.node_type} node`, 'info');
      }
      break;

    case 'node_completed': {
      const { result } = event;
      const statusIcon = result.status === 'passed' ? '✓' :
                        result.status === 'failed' ? '✗' :
                        result.status === 'error' ? '⚠' : '○';
      const logType: ConsoleLog['type'] =
        result.status === 'passed' ? 'success' :
        result.status === 'error' || result.status === 'failed' ? 'error' : 'info';

      const name = result.test_case_name || result.test_case_id || result.node_id;

      // Build collapsible details for request/response
      const details: ConsoleLogDetail[] = [];
      if (result.request) {
        details.push({ label: 'Request', value: `${result.request.method} ${result.request.url}` });
        if (result.request.headers && Object.keys(result.request.headers).length > 0) {
          details.push({ label: 'Headers', value: JSON.stringify(result.request.headers, null, 2) });
        }
        if (result.request.body) {
          // Try to pretty-print JSON payloads
          let body = result.request.body;
          try { body = JSON.stringify(JSON.parse(body), null, 2); } catch {}
          details.push({ label: 'Payload', value: body });
        }
      }
      if (result.response) {
        details.push({ label: 'Status', value: String(result.response.status), type: result.response.status >= 400 ? 'error' : 'info' });
        if (result.response.body) {
          let body = result.response.body.trim();
          try { body = JSON.stringify(JSON.parse(body), null, 2); } catch {}
          details.push({ label: 'Response', value: body });
        }
      }
      if (result.error_message) {
        details.push({ label: 'Error', value: result.error_message, type: 'error' });
      }
      // Engine notes for this node (unresolved variables, assertion reason, debug logs)
      if (result.logs && result.logs.length > 0) {
        details.push({ label: 'Logs', value: result.logs.join('\n') });
      }
      if (result.exports && Object.keys(result.exports).length > 0) {
        details.push({ label: 'Exports', value: JSON.stringify(result.exports, null, 2) });
      }

      addLog(`${statusIcon} ${name}: ${result.status} (${result.duration_ms}ms)`, logType, details.length > 0 ? details : undefined);
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
