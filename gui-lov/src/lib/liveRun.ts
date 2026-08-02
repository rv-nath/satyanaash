/**
 * A run in flight, in the shape a finished run comes back in.
 *
 * The report must not care whether a run has ended. A run tab reads `SuiteRun` — the
 * shape `runsApi.get` returns — so the stream is accumulated into a small live record
 * here and adapted to that same shape. One component, one set of renderers, and a run
 * that does not visibly change when its last member completes.
 *
 * The alternative was a second shape for live runs and a component that switched on
 * which it had. That is how a live run and its own history end up disagreeing.
 */
import type { FlowRun, MemberKind, SuiteRun, TestCaseExecutionResult } from '@/lib/api/types';

/** What the stream has told us so far about one member. */
export interface LiveMember {
  kind: MemberKind;
  memberId: string;
  name: string;
  /** Absent until `member_completed` — a member still going has no verdict yet. */
  status?: string;
  durationMs?: number;
  results: TestCaseExecutionResult[];
}

export interface LiveRun {
  /** The id this run is stored under, from `suite_started`. */
  runId: string;
  projectId?: string;
  suiteId?: string;
  suiteName: string;
  totalMembers: number;
  members: LiveMember[];
  /** Set by `completed`; absent while the run is still going. */
  status?: string;
  startedAt: string;
}

export function beginLiveRun(args: {
  runId: string;
  suiteId?: string;
  suiteName: string;
  totalMembers: number;
  startedAt: string;
}): LiveRun {
  return { ...args, members: [] };
}

export function startMember(
  run: LiveRun,
  member: { kind: MemberKind; memberId: string; name: string },
): LiveRun {
  return { ...run, members: [...run.members, { ...member, results: [] }] };
}

/**
 * File a node result under the member currently running.
 *
 * Node events carry no member id — the engine does not know it is inside a suite — so
 * they belong to the last member started. A result arriving before any member (which
 * should not happen) is dropped rather than inventing a member to hold it.
 */
export function addResult(run: LiveRun, result: TestCaseExecutionResult): LiveRun {
  if (run.members.length === 0) return run;
  const members = run.members.slice();
  const last = members.length - 1;
  members[last] = { ...members[last], results: [...members[last].results, result] };
  return { ...run, members };
}

export function completeMember(
  run: LiveRun,
  ordinal: number,
  status: string,
  durationMs: number,
): LiveRun {
  const members = run.members.slice();
  if (!members[ordinal]) return run;
  members[ordinal] = { ...members[ordinal], status, durationMs };
  return { ...run, members };
}

export function completeRun(run: LiveRun, status: string): LiveRun {
  return { ...run, status };
}

/** Node counts across everything recorded so far. Nodes, not rows — the rule the server
 *  follows, so a live footer and a stored one agree. */
function tally(members: LiveMember[]) {
  let passed = 0, failed = 0, errors = 0, skipped = 0, total = 0;
  for (const member of members) {
    for (const result of member.results) {
      total += 1;
      if (result.status === 'passed') passed += 1;
      else if (result.status === 'failed') failed += 1;
      else if (result.status === 'error') errors += 1;
      else skipped += 1;
    }
  }
  return { total, passed, failed, errors, skipped };
}

/**
 * The live record as a `SuiteRun`, so the report can render it with no special cases.
 *
 * Two things are deliberately approximate while the run is going and exact once it is
 * over: `duration_ms` is unset until `completed` (a partial duration presented as the
 * run's duration would be read as final), and a member with no verdict yet reports
 * `running` — which the tree shows as in-flight rather than as a result.
 */
export function liveRunToSuiteRun(run: LiveRun): SuiteRun {
  const counts = tally(run.members);

  const members: FlowRun[] = run.members.map((member, ordinal) => ({
    // Stable across renders and unique within the run, so React keys and selection
    // survive the next event arriving.
    id: `${run.runId}:${ordinal}`,
    suite_run_id: run.runId,
    ordinal,
    member_kind: member.kind,
    flow_id: member.kind === 'flow' ? member.memberId : null,
    test_case_id: member.kind === 'test' ? member.memberId : null,
    name: member.name,
    status: member.status ?? 'running',
    started_at: run.startedAt,
    duration_ms: member.durationMs ?? null,
    error_message: null,
    results: member.results,
  }));

  return {
    id: run.runId,
    project_id: run.projectId ?? '',
    suite_id: run.suiteId ?? null,
    suite_name: run.suiteName,
    status: run.status ?? 'running',
    started_at: run.startedAt,
    completed_at: null,
    duration_ms: null,
    ...counts,
    environment_name: null,
    error_message: null,
    members,
  };
}

/** How far through the members a live run is, for the footer. */
export function progressLine(run: LiveRun): string {
  const done = run.members.filter((m) => m.status !== undefined).length;
  const current = run.members[run.members.length - 1];
  if (run.status) return `${done} of ${run.totalMembers} members`;
  return current
    ? `member ${run.members.length} of ${run.totalMembers} — ${current.name}`
    : `starting ${run.totalMembers} members`;
}
