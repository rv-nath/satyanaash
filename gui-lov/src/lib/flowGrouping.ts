/**
 * Flows arranged into their sidebar buckets.
 *
 * Pure, so the arrangement can be tested without a sidebar — and separate from `TestInventory`'s
 * inline version because that one groups tests and this one groups flows. Sharing one function
 * would mean a signature generic over both, and the two lists disagree on enough (a virtual
 * bucket that is always drawn vs only when occupied) that the shared version would be mostly
 * branches.
 */

/** The id of the bucket that has no row in the database. */
export const UNGROUPED = "__ungrouped__";

export interface Bucket<T> {
  id: string;
  name: string;
  flows: T[];
  /** Ungrouped. It cannot be renamed or deleted, and dropping onto it means "no group". */
  virtual: boolean;
}

/**
 * Real groups newest-first, then Ungrouped.
 *
 * An empty *real* group is still drawn — you just made it, and a bucket that vanishes until
 * something is in it gives you nowhere to drop the first flow. Ungrouped is drawn only when it
 * holds something, because "Ungrouped (0)" is a heading about nothing.
 */
export function bucketsOf<T extends { id: string; groupId?: string | null }>(
  flows: T[],
  groups: { id: string; name: string }[],
): Bucket<T>[] {
  const byGroup = new Map<string, T[]>();
  for (const f of flows) {
    // A group id that no longer exists reads as Ungrouped rather than vanishing: the server
    // nulls these on delete, but a flow moved while another tab was open can arrive stale, and
    // a flow you cannot see is worse than one in the wrong bucket.
    const key = f.groupId && groups.some((g) => g.id === f.groupId) ? f.groupId : UNGROUPED;
    const arr = byGroup.get(key) ?? [];
    arr.push(f);
    byGroup.set(key, arr);
  }

  const out: Bucket<T>[] = groups.map((g) => ({
    id: g.id,
    name: g.name,
    flows: byGroup.get(g.id) ?? [],
    virtual: false,
  }));

  const ungrouped = byGroup.get(UNGROUPED) ?? [];
  if (ungrouped.length > 0) {
    out.push({ id: UNGROUPED, name: "Ungrouped", flows: ungrouped, virtual: true });
  }
  return out;
}

/** Where a project's collapsed buckets are remembered. Per project, so two projects don't share. */
export function collapseKey(projectId: string | undefined): string {
  return `sat.flowGroups.collapsed.${projectId || "none"}`;
}

/**
 * What a drop onto a bucket means for the flow being dragged.
 *
 * `null` for Ungrouped — a real move, not a no-op, which is where this differs from the tests
 * rail. `undefined` means the drop changes nothing and should not hit the network.
 */
export function dropTarget(
  bucketId: string,
  flowCurrentGroupId: string | null | undefined,
): string | null | undefined {
  const target = bucketId === UNGROUPED ? null : bucketId;
  const current = flowCurrentGroupId ?? null;
  return target === current ? undefined : target;
}
