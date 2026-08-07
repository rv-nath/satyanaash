/**
 * The shape of a run as a tree, and what starts open.
 *
 * Four levels, matching the schema: run → member → node → row. Kept pure so the
 * expansion rule and the selection addressing can be tested without a DOM — those are
 * the parts with actual behaviour; the rest is markup.
 */
import type { FlowRun, SuiteRun, TestCaseExecutionResult } from '@/lib/api/types';
import { iterationNoun } from '@/lib/consoleDetails';

/** Which thing in the tree is selected. Addressed by position, because a node id repeats
 *  across members and a row index repeats across nodes. */
export interface TreePath {
  member: number;
  node?: number;
  row?: number;
}

export function pathKey(path: TreePath): string {
  return [path.member, path.node ?? '', path.row ?? ''].join(':');
}

export function samePath(a: TreePath | null, b: TreePath | null): boolean {
  if (!a || !b) return a === b;
  return pathKey(a) === pathKey(b);
}

/** The result a path points at, or undefined if the tree has changed under it. */
export function resultAt(run: SuiteRun, path: TreePath): TestCaseExecutionResult | undefined {
  const member = run.members?.[path.member];
  if (!member || path.node === undefined) return undefined;
  const node = member.results?.[path.node];
  if (!node || path.row === undefined) return node;
  return node.iterations?.[path.row];
}

/** Breadcrumb for the detail pane: what you are looking at, and inside what. */
export function breadcrumb(run: SuiteRun, path: TreePath): string[] {
  const member = run.members?.[path.member];
  if (!member) return [];
  const crumbs = [member.name];

  const node = path.node !== undefined ? member.results?.[path.node] : undefined;
  if (node) crumbs.push(node.node_label || node.test_case_name || node.node_id);

  if (node && path.row !== undefined) {
    const row = node.iterations?.[path.row];
    if (row) crumbs.push(row.row_label ?? `${iterationNoun(node).One} ${(row.row_index ?? path.row) + 1}`);
  }
  return crumbs;
}

const isProblem = (status: string) => status === 'failed' || status === 'error';

/** Did anything inside this member not pass? */
export function memberHasProblem(member: FlowRun): boolean {
  if (isProblem(member.status)) return true;
  return (member.results ?? []).some(nodeHasProblem);
}

export function nodeHasProblem(node: TestCaseExecutionResult): boolean {
  if (isProblem(node.status)) return true;
  return (node.iterations ?? []).some((row) => isProblem(row.status));
}

/**
 * What is open when a run is first shown.
 *
 * Failures expand, passes stay shut — the same rule the dataset row markers follow: say
 * something only when there is something to say. A green run of sixteen nodes is a
 * summary you scroll past; a red one should already be showing you the red.
 *
 * A member still running is expanded too. It is the one you are watching.
 */
export function initiallyExpanded(run: SuiteRun): Set<string> {
  const open = new Set<string>();
  (run.members ?? []).forEach((member, m) => {
    const watching = member.status === 'running';
    if (!watching && !memberHasProblem(member)) return;
    open.add(pathKey({ member: m }));

    (member.results ?? []).forEach((node, n) => {
      if (nodeHasProblem(node)) open.add(pathKey({ member: m, node: n }));
    });
  });
  return open;
}

/** Row counts for a fan-out node, for its one line in the tree. */
export function rowSummary(node: TestCaseExecutionResult): string | undefined {
  const rows = node.iterations;
  if (!rows || rows.length === 0) return undefined;
  const passed = rows.filter((r) => r.status === 'passed').length;
  const skipped = rows.filter((r) => r.status === 'skipped').length;
  const ran = rows.length - skipped;
  // Skips are named rather than folded into the denominator: "2/2" beside thirteen
  // untested rows reads as coverage it hasn't got.
  const noun = iterationNoun(node);
  if (ran === 0) return `${rows.length} ${noun.many}, none ran`;
  const base = `${passed}/${ran} ${noun.many}`;
  return skipped > 0 ? `${base} · ${skipped} skipped` : base;
}
