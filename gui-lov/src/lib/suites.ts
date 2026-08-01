/**
 * Suite membership — the selection, and what it says it covers.
 *
 * Everything here turns on one distinction that is easy to lose: **an absent `members`
 * means every flow and test in the project, an empty one means none.** They are not the
 * same, and collapsing them would either silently run the whole project when the author
 * narrowed it to nothing, or silently run nothing when they meant everything.
 *
 * New suites are created empty. "Everything" is a deliberate choice for the suite that
 * wants to pick up tomorrow's new flow on its own, not a default that can't say what it
 * covers until it has run.
 */
import type { Flow, MemberKind, Suite, SuiteMember, TestCase } from '@/lib/api/types';
import { runnableAlone } from '@/lib/dataset';

/** Is this suite set to cover everything, including whatever is added later? */
export function coversEverything(suite: Pick<Suite, 'members'>): boolean {
  return suite.members == null;
}

/** Is this member ticked? Everything-mode ticks all of them. */
export function isSelected(
  suite: Pick<Suite, 'members'>,
  kind: MemberKind,
  id: string,
): boolean {
  if (coversEverything(suite)) return true;
  return suite.members!.some((m) => m.kind === kind && m.id === id);
}

/**
 * Tick or untick one member, returning the new selection.
 *
 * Unticking while in everything-mode has to materialise the list first — otherwise the
 * one thing you excluded would be the only thing recorded.
 */
export function toggleMember(
  suite: Pick<Suite, 'members'>,
  kind: MemberKind,
  id: string,
  available: SuiteMember[],
): SuiteMember[] {
  const current = coversEverything(suite) ? available : suite.members!;
  const has = current.some((m) => m.kind === kind && m.id === id);
  if (has) return current.filter((m) => !(m.kind === kind && m.id === id));

  // Added members follow the order things appear in the project, not the order they were
  // ticked, so the run order is the one the author reads down the list.
  const next = [...current, { kind, id }];
  return available.filter((a) => next.some((m) => m.kind === a.kind && m.id === a.id));
}

/** Every flow and test in the project, in the order a suite would run them. */
export function allMembers(flows: Flow[], tests: TestCase[]): SuiteMember[] {
  return [
    ...flows.map((f): SuiteMember => ({ kind: 'flow', id: f.id })),
    ...tests.map((t): SuiteMember => ({ kind: 'test', id: t.id })),
  ];
}

/** How many members this suite would run right now. */
export function memberCount(suite: Pick<Suite, 'members'>, available: SuiteMember[]): number {
  return coversEverything(suite) ? available.length : suite.members!.length;
}

/**
 * What the Run button says.
 *
 * A count on its own can't tell "nothing picked yet" from "nothing left in the project",
 * and the first is the ordinary state of a new suite.
 */
export function runLabel(suite: Pick<Suite, 'members'>, available: SuiteMember[]): string {
  const count = memberCount(suite, available);
  if (count === 0) return 'Nothing selected';
  return `Run ${count}`;
}

/** Can this suite be run at all? A blank suite is not an error, just not ready. */
export function canRun(suite: Pick<Suite, 'members'>, available: SuiteMember[]): boolean {
  return memberCount(suite, available) > 0;
}

/**
 * A note beside a test in the picker, for the ones a suite can't satisfy alone.
 *
 * Every row parked or needing a flow means the test would be included and then skip
 * everything — worth saying before the run rather than discovering it in the results. A
 * test with no dataset has no row to carry that flag, so there is nothing to say about it
 * here; that gap is why a test-case-level marking is still open.
 */
export function memberNote(test: Pick<TestCase, 'dataset'>): string | undefined {
  const dataset = test.dataset;
  const total = dataset?.rows.length ?? 0;
  if (!dataset || total === 0) return undefined;

  const runnable = runnableAlone(dataset).length;
  if (runnable === 0) return 'no rows can run alone';
  if (runnable === total) return `${total} rows`;
  return `${runnable} of ${total} rows`;
}
