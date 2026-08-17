/**
 * Filtering the flows rail.
 *
 * A flow's name is the obvious thing to match, but the more useful question is "which
 * flow uses this request?" — so the requests inside a flow match too. That has a cost
 * worth paying attention to: a flow called *Campaign smoke* appearing under the query
 * `login` reads as a bug unless the row says why. So a match carries **which requests
 * matched**, and the rail shows them.
 */

export interface SearchableRequest {
  name: string;
  method?: string;
  endpoint?: string;
}

export interface SearchableFlow {
  name: string;
  description?: string;
  testCases: SearchableRequest[];
}

/**
 * The requests a flow's nodes reference, resolved against the project's test cases.
 *
 * `Flow.testCases` is hard-coded to `[]` for every flow loaded from the API, so the "and their
 * requests" half of the search box has never been able to match anything — the filter below ran
 * over an empty array and the `via …` annotation could never render. The data was there the
 * whole time, one step away: each node carries `data.testCaseId`, and the project's requests are
 * already in the query cache for the rail beside this one.
 *
 * Deduplicated by id, because two nodes may run the same request in different roles and "via
 * Login +1" would then be counting one request twice.
 */
export function requestsOf(
  nodes: { data?: Record<string, unknown> }[] | undefined,
  byId: Map<string, SearchableRequest>,
): SearchableRequest[] {
  const seen = new Set<string>();
  const out: SearchableRequest[] = [];
  for (const node of nodes ?? []) {
    const id = node.data?.testCaseId;
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    const request = byId.get(id);
    if (request) out.push(request);
  }
  return out;
}

export interface FlowMatch<T> {
  flow: T;
  /**
   * The requests that matched, when the flow's own name or description did not.
   *
   * Empty for a direct hit — the row already shows the name that matched, and repeating
   * it would be noise.
   */
  matchedRequests: string[];
}

/** Case-insensitive substring, the same rule the tests rail uses. */
function has(haystack: string | undefined, needle: string): boolean {
  return (haystack ?? "").toLowerCase().includes(needle);
}

/**
 * Which flows survive `query`, and why.
 *
 * A blank query keeps everything with no annotations — searching nothing is not a filter.
 */
export function filterFlows<T extends SearchableFlow>(flows: T[], query: string): FlowMatch<T>[] {
  const q = query.trim().toLowerCase();
  if (!q) return flows.map((flow) => ({ flow, matchedRequests: [] }));

  const matches: FlowMatch<T>[] = [];
  for (const flow of flows) {
    // A direct hit needs no explanation, and must not be annotated with every request
    // that happens to contain the same word.
    if (has(flow.name, q) || has(flow.description, q)) {
      matches.push({ flow, matchedRequests: [] });
      continue;
    }
    const matchedRequests = flow.testCases
      .filter((tc) => has(tc.name, q) || has(tc.method, q) || has(tc.endpoint, q))
      .map((tc) => tc.name);
    if (matchedRequests.length > 0) matches.push({ flow, matchedRequests });
  }
  return matches;
}

/** "via Login-2-Ngage", "via Login-2-Ngage +2" — why an indirect match is in the list. */
export function matchNote(matchedRequests: string[]): string | undefined {
  const [first, ...rest] = matchedRequests;
  if (!first) return undefined;
  return rest.length > 0 ? `via ${first} +${rest.length}` : `via ${first}`;
}
