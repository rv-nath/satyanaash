/**
 * Reading a stored run.
 *
 * A past run must read exactly like a live one, so nothing here reformats results — the
 * console's own renderers (`resultHeadline`, `resultDetails`, `fanOutDetails`) take a
 * `TestCaseExecutionResult`, and that is precisely what a stored run unpacks into. What
 * this file adds is the headline arithmetic for a *run*, which the console never had to
 * do because it only ever showed one flow at a time.
 */
import type { SuiteRun, TestCaseExecutionResult } from '@/lib/api/types';
import { fanOutDetails, resultDetails, type ConsoleLogDetail } from '@/lib/consoleDetails';

/**
 * Which renderer a stored result goes through — the same choice the console makes.
 *
 * A fan-out aggregate carries `iterations` and needs the per-row treatment; anything else
 * is one request. Kept here rather than inline in the component so the dispatch is
 * testable without a DOM, and so there is one place that decides it for both surfaces.
 */
export function detailsFor(result: TestCaseExecutionResult): ConsoleLogDetail[] {
  return result.iterations ? fanOutDetails(result) : resultDetails(result);
}

/**
 * What to call a node in the history.
 *
 * The alias first, because two nodes can run one test case in different roles and a line
 * saying only "Login" cannot tell them apart. The node id last, so a start or end node
 * still has something to show.
 */
export function nodeTitle(result: Pick<TestCaseExecutionResult, 'node_label' | 'test_case_name' | 'node_id'>): string {
  return result.node_label || result.test_case_name || result.node_id;
}

/**
 * Console key prefix for a suite's run.
 *
 * A suite spans several flows, so its output cannot live under any one flow's key without
 * leaving that flow's console holding another run's history. Prefixed so it can never
 * collide with a flow id.
 */
export const SUITE_LOG_PREFIX = 'suite:';

export const suiteLogKey = (suiteId: string) => `${SUITE_LOG_PREFIX}${suiteId}`;

/** Whether a run is still going. Written before the first member executes, so a run that
 *  died with the server stays visible as `running` rather than vanishing. */
export function isInFlight(run: Pick<SuiteRun, 'status'>): boolean {
  return run.status === 'running';
}

export type RunVerdict = 'passed' | 'failed' | 'error' | 'stopped' | 'running';

/**
 * One word for the whole run.
 *
 * `completed` is the engine's word for "the traversal finished", which is not the same as
 * "everything passed" — a run can complete with four failures. The history has to say
 * which, because a list of green "completed" rows hiding failures is the dishonest green
 * this project keeps designing against.
 */
export function verdict(run: Pick<SuiteRun, 'status' | 'failed' | 'errors'>): RunVerdict {
  if (run.status === 'running') return 'running';
  if (run.status === 'stopped') return 'stopped';
  if (run.errors > 0) return 'error';
  if (run.failed > 0) return 'failed';
  return 'passed';
}

export function verdictIcon(v: RunVerdict): string {
  return { passed: '✓', failed: '✗', error: '!', stopped: '□', running: '…' }[v];
}

/**
 * The counts line beside a run.
 *
 * Skips are named rather than folded into the total, for the same reason a fan-out node
 * names them: "6/6 passed" beside four skipped members reads as coverage it doesn't have.
 */
export function countsLine(run: Pick<SuiteRun, 'total' | 'passed' | 'failed' | 'errors' | 'skipped'>): string {
  const ran = run.total - run.skipped;
  if (ran === 0) {
    return run.total === 0 ? 'nothing ran' : `nothing ran — all ${run.total} skipped`;
  }
  const parts = [`${run.passed}/${ran} passed`];
  if (run.failed > 0) parts.push(`${run.failed} failed`);
  if (run.errors > 0) parts.push(`${run.errors} errored`);
  if (run.skipped > 0) parts.push(`${run.skipped} skipped`);
  return parts.join(' · ');
}

/** "1.2s", "340ms", "2m 05s" — a run is minutes where a node was milliseconds. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** "just now", "14:32", "31 Jul 14:32" — recent runs are the ones being compared. */
export function formatWhen(iso: string, now = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;

  const sameDay = then.toDateString() === now.toDateString();
  const time = then.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) {
    return now.getTime() - then.getTime() < 60_000 ? 'just now' : time;
  }
  const day = then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return `${day} ${time}`;
}

/**
 * How a run describes what it ran.
 *
 * An ad-hoc single-flow run has no suite, and saying "Suite: JT1 – SMS" about it would
 * invent one. The name is the same either way; what differs is whether it was a selection.
 */
export function runSubtitle(run: Pick<SuiteRun, 'suite_id' | 'members'>): string {
  const count = run.members?.length ?? 0;
  if (!run.suite_id) return count > 1 ? `${count} members` : 'single run';
  return count === 1 ? 'suite · 1 member' : `suite · ${count} members`;
}
