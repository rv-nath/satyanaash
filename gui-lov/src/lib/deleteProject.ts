/**
 * Deleting a project, which is the one action in this app that cannot be undone by hand.
 *
 * Every other delete removes one thing you can rebuild in a minute. A project cascades:
 * `ON DELETE CASCADE` on `test_cases`, `flows`, `suites`, `suite_runs` and `file_stores` means
 * every request, every flow, every suite and **the whole run history** go with it. There is no
 * export and no undo.
 *
 * So the dialog does two things a bare "are you sure?" does not:
 *
 * - **It says what is at stake.** A confirmation with no stakes in it is a rubber stamp; the
 *   counts are the only part that makes someone stop and read.
 * - **It asks for the name.** Typing it is a deliberate act, where a second click is a reflex —
 *   and this is exactly the mistake nobody can walk back.
 */

export interface ProjectContents {
  /** Undefined while loading, or if the count could not be fetched. */
  requests?: number;
  flows?: number;
  suites?: number;
  runs?: number;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "18 requests, 6 flows, 1 suite and 12 runs" — an English list, not a table of zeroes. */
export function lossSummary(contents: ProjectContents): string | undefined {
  const parts: string[] = [];
  if (contents.requests) parts.push(plural(contents.requests, "request"));
  if (contents.flows) parts.push(plural(contents.flows, "flow"));
  if (contents.suites) parts.push(plural(contents.suites, "suite"));
  if (contents.runs) parts.push(plural(contents.runs, "run"));

  // Nothing counted: either the project really is empty, or the counts have not arrived. The
  // caller tells those apart — inventing "0 requests" here would read as a fact.
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** True once every count has arrived, so the dialog knows whether it can speak with authority. */
export function contentsKnown(contents: ProjectContents): boolean {
  return (
    contents.requests !== undefined &&
    contents.flows !== undefined &&
    contents.suites !== undefined &&
    contents.runs !== undefined
  );
}

/**
 * Whether what was typed matches the project's name.
 *
 * Trimmed, because a paste picks up whitespace and that is not the mistake this is guarding
 * against. **Case-sensitive**, because the point is deliberateness: approximately typing the
 * name is how a safeguard becomes a formality.
 */
export function nameMatches(typed: string, name: string): boolean {
  return typed.trim() === name.trim() && name.trim().length > 0;
}
