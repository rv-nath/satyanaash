import { describe, it, expect } from "vitest";
import { filterFlows, matchNote, type SearchableFlow } from "@/lib/flowSearch";

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
