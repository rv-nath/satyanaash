import { describe, it, expect } from "vitest";
import { contentsKnown, lossSummary, nameMatches } from "@/lib/deleteProject";

describe("what a project delete takes with it", () => {
  it("reads as a sentence, not a table", () => {
    // This is the only part of the dialog that makes anyone stop and read, so it has to be
    // legible at a glance.
    expect(lossSummary({ requests: 18, flows: 6, suites: 1, runs: 12 })).toBe(
      "18 requests, 6 flows, 1 suite and 12 runs",
    );
    expect(lossSummary({ requests: 1, flows: 1, suites: 1, runs: 1 })).toBe(
      "1 request, 1 flow, 1 suite and 1 run",
    );
  });

  it("leaves out what there is none of", () => {
    // "0 suites" is noise, and a list of zeroes buries the number that matters.
    expect(lossSummary({ requests: 3, flows: 0, suites: 0, runs: 0 })).toBe("3 requests");
    expect(lossSummary({ requests: 2, flows: 1, suites: 0, runs: 0 })).toBe("2 requests and 1 flow");
  });

  it("says nothing at all rather than claiming a project is empty", () => {
    // Undefined counts mean they have not arrived. Rendering "0 requests" from that would state
    // a fact nobody checked — and the whole point of this dialog is that its facts are true.
    expect(lossSummary({})).toBeUndefined();
    expect(lossSummary({ requests: 0, flows: 0, suites: 0, runs: 0 })).toBeUndefined();
  });

  it("knows whether it can speak with authority yet", () => {
    expect(contentsKnown({ requests: 0, flows: 0, suites: 0, runs: 0 })).toBe(true);
    expect(contentsKnown({ requests: 3, flows: 1, suites: 1 })).toBe(false);
    expect(contentsKnown({})).toBe(false);
  });
});

describe("typing the name to confirm", () => {
  it("accepts the name, and tolerates the whitespace a paste brings", () => {
    expect(nameMatches("ng-acc", "ng-acc")).toBe(true);
    expect(nameMatches("  ng-acc  ", "ng-acc")).toBe(true);
  });

  it("is case-sensitive, because approximate typing makes a safeguard a formality", () => {
    expect(nameMatches("NG-ACC", "ng-acc")).toBe(false);
    expect(nameMatches("ng acc", "ng-acc")).toBe(false);
    expect(nameMatches("ng-ac", "ng-acc")).toBe(false);
  });

  it("cannot be satisfied by typing nothing into an unnamed project", () => {
    // Otherwise a project with a blank name would delete on an empty field and one Enter.
    expect(nameMatches("", "")).toBe(false);
    expect(nameMatches("   ", "  ")).toBe(false);
    expect(nameMatches("", "ng-acc")).toBe(false);
  });
});
