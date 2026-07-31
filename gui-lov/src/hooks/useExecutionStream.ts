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

/** Parked before this node, waiting for a press. */
interface ExecutionEventPaused {
  type: 'paused';
  node_id: string;
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
  | ExecutionEventPaused
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
  /** Run a node at a time, waiting for a press before each one after the first. */
  step?: boolean;
}

/** What the author can press while a run is paused. Mirrors the server's StepCommand. */
export type StepCommand = 'next' | 'run_to_end' | 'stop';

/**
 * Where a run has got to, from the controls' point of view.
 *
 * `finishing` is the state after Run to end or Stop: the run is still going but will
 * not pause again, so there is nothing left to press.
 */
export type RunMode = 'idle' | 'running' | 'paused' | 'finishing';

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

  // Every node's own result, kept per flow like the logs. The console has always
  // rendered these into text and thrown the result away, which left the canvas with
  // nothing to show and the node popover nothing to report.
  const [nodeRuns, setNodeRuns] = useState<Record<string, Record<string, NodeResult>>>({});
  // The node whose request is in flight, and the node a paused run is waiting to run.
  // One run at a time, so these are single values rather than per flow.
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [pausedNodeId, setPausedNodeId] = useState<string | null>(null);
  const [runMode, setRunMode] = useState<RunMode>('idle');
  // The run's server-side id, learned from the started event. Without it there is no
  // way to address the controls at a paused run.
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [totalNodes, setTotalNodes] = useState(0);

  // Which flow the events arriving right now belong to. A ref because addLog is
  // called from the stream loop, long after the state that started it.
  const targetFlowRef = useRef<string | null>(null);

  // Store AbortController to cancel previous stream
  const abortControllerRef = useRef<AbortController | null>(null);

  // Held in a ref so `execute` stays stable as the callback's identity changes.
  const onEnvWritesRef = useRef(onEnvWrites);
  onEnvWritesRef.current = onEnvWrites;

  // Which run is the current one. Aborting a fetch doesn't stop the invocation that
  // owns it: its loop still unwinds, its catch still runs, and its `finally` still
  // fires — after the run that replaced it has already set the state that `finally`
  // resets. A superseded run must therefore write nothing at all.
  const runSeqRef = useRef(0);

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

  /** Record what a node did, against the flow the events belong to. */
  const recordResult = useCallback((nodeId: string, result: NodeResult) => {
    const flowId = targetFlowRef.current;
    if (!flowId) return;
    setNodeRuns(prev => ({
      ...prev,
      [flowId]: { ...(prev[flowId] ?? {}), [nodeId]: result },
    }));
  }, []);

  /**
   * Press one of the paused run's controls.
   *
   * Optimistic on purpose: the button should stop looking pressable the instant it is
   * clicked, not a round trip later. A 404 means the run finished while the author was
   * deciding, which the completed event is about to explain anyway.
   */
  const step = useCallback(async (command: StepCommand) => {
    const id = executionId;
    if (!id) return;
    setPausedNodeId(null);
    setRunMode(command === 'next' ? 'running' : 'finishing');
    try {
      const response = await fetch(`${API_URL}/executions/${id}/step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
      if (!response.ok && response.status !== 404) {
        addLog(`Could not ${command.replace(/_/g, ' ')}: HTTP ${response.status}`, 'error');
      }
    } catch (error) {
      addLog(`Could not ${command.replace(/_/g, ' ')}: ${error instanceof Error ? error.message : 'unknown error'}`, 'error');
    }
  }, [executionId, addLog]);

  const cancelExecution = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setExecutingFlowId(null);
      addLog('Execution cancelled', 'info');
    }
  }, [addLog]);

  const execute = useCallback(async (flowId: string, options: ExecuteFlowRequest = {}) => {
    // This run's ticket. Everything below writes only while it holds it.
    const runSeq = ++runSeqRef.current;
    const current = () => runSeqRef.current === runSeq;

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
    // A re-run replaces the previous one rather than appending to it — the canvas
    // decoration included, or last run's ticks would linger over this one.
    setLogsByFlow(prev => ({ ...prev, [flowId]: [] }));
    setNodeRuns(prev => ({ ...prev, [flowId]: {} }));
    setActiveNodeId(null);
    setPausedNodeId(null);
    setExecutionId(null);
    setRunMode(options.step ? 'running' : 'finishing');
    addLog(options.step ? 'Starting step-by-step execution...' : 'Starting execution...', 'info');

    // SAT.env writes from every node in this run. Collected as events stream in and
    // applied once at the end — one project update instead of one per node.
    const envWrites: Record<string, unknown> = {};

    // Where the stream loop puts what it reads. Bundled rather than passed one
    // parameter at a time: there are six of them now.
    //
    // Every writer is gated on this still being the current run. The previous stream
    // keeps delivering for a moment after it's aborted, and its events would otherwise
    // land in the log this run has just cleared — which reads as "the console kept the
    // last run's output", and puts the tail of one run into the copy of another.
    const sink: EventSink = {
      addLog: (message, type, details) => { if (current()) addLog(message, type, details); },
      envWrites,
      recordResult: (nodeId, result) => { if (current()) recordResult(nodeId, result); },
      setActiveNodeId: (id) => { if (current()) setActiveNodeId(id); },
      setPausedNodeId: (id) => { if (current()) setPausedNodeId(id); },
      setRunMode: (next) => { if (current()) setRunMode(next); },
      setExecutionId: (id) => { if (current()) setExecutionId(id); },
      setTotalNodes: (n) => { if (current()) setTotalNodes(n); },
    };

    try {
      const response = await fetch(`${API_URL}/flows/${flowId}/execute-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          debug_mode: options.debug_mode ?? false,
          environment: options.environment ?? {},
          variables: options.variables ?? {},
          step: options.step ?? false,
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
              handleEvent(event, sink);
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
          handleEvent(event, sink);
        } catch (parseError) {
          console.warn('Failed to parse final SSE event:', jsonStr, parseError);
        }
      }

      // Persist SAT.env writes made during the run (matches standalone behaviour).
      const written = Object.keys(envWrites);
      if (written.length > 0 && current()) {
        onEnvWritesRef.current?.(envWrites);
        addLog(`Saved ${written.length} environment variable(s): ${written.join(', ')}`, 'info');
      }

    } catch (error) {
      if (!current()) return; // superseded: not this run's news to report
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
      // Only if this is still the run in progress. A superseded invocation reaching here
      // would otherwise report *its* ending as the current one's: no spinner, no step
      // controls, and no execution id for the controls to address.
      if (current()) {
        setExecutingFlowId(null);
        // The stream is over however it ended, so nothing is running and nothing is
        // waiting to be pressed. The results stay: they are what the canvas and the
        // node popovers report until the next run.
        setActiveNodeId(null);
        setPausedNodeId(null);
        setRunMode('idle');
        setExecutionId(null);
        abortControllerRef.current = null;
      }
    }
  }, [addLog, recordResult]);

  return {
    logsByFlow,
    /** The flow currently running, if any — one execution at a time. */
    executingFlowId,
    isExecuting: executingFlowId !== null,
    execute,
    cancelExecution,
    clearLogs,
    closeLogs,
    /** Per flow, per node: what it did last time. Outlives the run. */
    nodeRuns,
    activeNodeId,
    pausedNodeId,
    runMode,
    totalNodes,
    step,
  };
}

/** Where the stream loop puts what it reads. */
interface EventSink {
  addLog: (message: string, type: ConsoleLog['type'], details?: ConsoleLogDetail[]) => void;
  envWrites: Record<string, unknown>;
  recordResult: (nodeId: string, result: NodeResult) => void;
  setActiveNodeId: (id: string | null) => void;
  setPausedNodeId: (id: string | null) => void;
  setRunMode: (next: RunMode | ((prev: RunMode) => RunMode)) => void;
  setExecutionId: (id: string) => void;
  setTotalNodes: (n: number) => void;
}

/** Handle individual execution events */
function handleEvent(event: ExecutionEvent, sink: EventSink) {
  const { addLog, envWrites } = sink;
  switch (event.type) {
    case 'started':
      sink.setExecutionId(event.execution_id);
      sink.setTotalNodes(event.total_nodes);
      addLog(`Execution ${event.execution_id.slice(0, 8)}... started (${event.total_nodes} nodes)`, 'info');
      break;

    case 'node_started':
      sink.setActiveNodeId(event.node_id);
      if (event.node_type === 'testCase') {
        addLog(`▶ Running: ${nodeName(event)}`, 'info');
      } else if (event.node_type !== 'start' && event.node_type !== 'end') {
        addLog(`▶ Entering: ${event.node_type} node`, 'info');
      }
      break;

    case 'paused':
      sink.setPausedNodeId(event.node_id);
      sink.setRunMode('paused');
      break;

    case 'node_completed': {
      const { result } = event;
      sink.setActiveNodeId(null);
      sink.recordResult(event.node_id, result);
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
