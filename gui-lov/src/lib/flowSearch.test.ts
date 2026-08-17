import { describe, it, expect } from "vitest";
import { filterFlows, matchNote, requestsOf, type SearchableFlow, type SearchableRequest } from "@/lib/flowSearch";

const flow = (name: string, requests: [string, string, string][] = []): SearchableFlow => ({
  name,
  testCases: requests.map(([n, method, endpoint]) => ({ name: n, method, endpoint })),
});

const flows = [
  flow("Upload and verify numbers", [
    ["Login-2-Ngage", "POST", "/api/v1/accounts/users/login"],
    ["Upload numbers", "POST", "/api/v1/numbers/upload"],
    ["Get Numbers", "GET", "/api/v1/numbers"],
  ]),
  flow("Campaign smoke", [
    ["Login-2-Ngage", "POST", "/api/v1/accounts/users/login"],
    ["Create campaign", "POST", "/api/v1/campaigns"],
  ]),
  flow("Contacts upload", []),
];

const names = (query: string) => filterFlows(flows, query).map((m) => m.flow.name);

describe("filtering the flows rail", () => {
  it("keeps everything when nothing is typed", () => {
    // Searching nothing is not a filter.
    expect(filterFlows(flows, "").length).toBe(3);
    expect(filterFlows(flows, "   ").length).toBe(3);
  });

  it("matches a flow's own name, case-insensitively", () => {
    expect(names("upload")).toEqual(["Upload and verify numbers", "Contacts upload"]);
    expect(names("CAMPAIGN smoke")).toEqual(["Campaign smoke"]);
  });

  it("answers the question the rail is actually for: which flow uses this request?", () => {
    // Neither flow is named "login", and both use it. Matching only names would have
    // returned nothing at all.
    expect(names("login")).toEqual(["Upload and verify numbers", "Campaign smoke"]);
    expect(names("/api/v1/campaigns")).toEqual(["Campaign smoke"]);
  });

  it("says which request matched, because otherwise the row looks like a bug", () => {
    // "Campaign smoke" under the query `login` needs an explanation.
    const [match] = filterFlows(flows, "create campaign");
    expect(match.matchedRequests).toEqual(["Create campaign"]);
    expect(matchNote(match.matchedRequests)).toBe("via Create campaign");
  });

  it("annotates nothing when the flow's own name matched", () => {
    // The row already shows the name that matched — repeating it would be noise, and
    // listing every request containing the same word would be worse.
    const [match] = filterFlows(flows, "campaign smoke");
    expect(match.matchedRequests).toEqual([]);
    expect(matchNote(match.matchedRequests)).toBeUndefined();
  });

  it("counts the rest rather than listing them all", () => {
    // Three requests in one flow contain "numbers"; the row has one line.
    const [match] = filterFlows(flows, "numbers");
    expect(match.flow.name).toBe("Upload and verify numbers");
    // That one matched by its own name, so look at a query that only requests carry.
    const [byMethod] = filterFlows(flows, "post");
    expect(matchNote(byMethod.matchedRequests)).toBe("via Login-2-Ngage +1");
  });

  it("drops a flow nothing in it matches", () => {
    expect(names("nonesuch")).toEqual([]);
    // A flow with no requests can only match on its own name.
    expect(names("contacts")).toEqual(["Contacts upload"]);
  });
});

/**
 * Turning a flow's nodes into the requests it runs.
 *
 * `filterFlows` had nothing to filter: every flow arrived with `testCases: []`, so the "and
 * their requests" half of the search box could never match and the `via …` annotation could
 * never appear. This is the missing step.
 */
describe("requestsOf", () => {
  const byId = new Map<string, SearchableRequest>([
    ["tc1", { name: "SignUp API", method: "POST", endpoint: "/accounts/users/signup" }],
    ["tc2", { name: "Login-2-Ngage", method: "POST", endpoint: "/login" }],
  ]);
  const node = (testCaseId?: string) => ({ data: testCaseId ? { testCaseId } : {} });

  it("resolves the requests a flow's nodes reference", () => {
    expect(requestsOf([node("tc1"), node("tc2")], byId).map((r) => r.name)).toEqual([
      "SignUp API",
      "Login-2-Ngage",
    ]);
  });

  it("counts a request once even when two nodes run it", () => {
    // Two nodes can run one request in different roles. Counting it twice would make
    // "via Login-2-Ngage +1" claim two requests where there is one.
    expect(requestsOf([node("tc2"), node("tc2")], byId)).toHaveLength(1);
  });

  it("skips nodes that reference no request", () => {
    // start, end, and a sub-flow node carry no testCaseId.
    expect(requestsOf([node(), node("tc1"), node()], byId).map((r) => r.name)).toEqual(["SignUp API"]);
  });

  it("skips an id the project no longer has", () => {
    // A deleted request leaves the node behind; naming it would be inventing a request.
    expect(requestsOf([node("gone")], byId)).toEqual([]);
  });

  it("copes with a flow whose graph has not loaded", () => {
    expect(requestsOf(undefined, byId)).toEqual([]);
  });
});
