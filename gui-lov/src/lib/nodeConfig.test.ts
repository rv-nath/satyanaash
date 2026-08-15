import { describe, it, expect } from "vitest";
import {
  collectionSummary,
  itemVarSuggestion,
  listName,
  runModeOf,
  stripBraces,
  walkBadge,
  walkSummary,
  awaitListCheck,
  awaitProgress,
  callbackUrlToSend,
  rootPathWarning,
  AWAIT_TIMEOUT_MS,
  awaitBadge,
  awaitSummary,
} from "@/lib/nodeConfig";

describe("how many times a step runs", () => {
  it("is once when nothing says otherwise", () => {
    expect(runModeOf(undefined)).toBe("once");
    expect(runModeOf({})).toBe("once");
    expect(runModeOf({ outputVars: [{ name: "token", path: "$.token" }] })).toBe("once");
  });

  it("reads a dataset fan-out and a list walk apart", () => {
    expect(runModeOf({ forEachRow: true })).toBe("rows");
    expect(runModeOf({ forEach: { list: "launched" } })).toBe("items");
  });

  it("opens a node set to both on something coherent rather than nothing", () => {
    // Unreachable from the toggle, reachable through the API. The engine still refuses to
    // run it — the panel just has to render, so the author can see what it says and fix it.
    expect(runModeOf({ forEachRow: true, forEach: { list: "launched" } })).toBe("items");
  });

  it("treats a forEach with no list as not walking anything", () => {
    // Otherwise the panel shows the walk fields for a config that cannot run, and the
    // three-way toggle would land on "items" for an empty block left behind.
    expect(runModeOf({ forEach: {} })).toBe("once");
    expect(runModeOf({ forEach: { list: "   " } })).toBe("once");
  });
});

describe("the list name", () => {
  it("forgives the braces everyone types", () => {
    // `{{launched}}` is how a variable is written everywhere else in this app, so both
    // readings have to mean the same thing — here and in the engine.
    expect(listName({ list: "{{launched}}" })).toBe("launched");
    expect(listName({ list: "  launched  " })).toBe("launched");
    expect(stripBraces("{{ launched }}")).toBe("launched");
  });

  it("is empty when there is nothing to walk", () => {
    expect(listName(undefined)).toBe("");
    expect(listName({})).toBe("");
  });
});

describe("suggesting a name for each item", () => {
  it("offers the singular of an obvious plural", () => {
    expect(itemVarSuggestion("campaignIds")).toBe("campaignId");
    expect(itemVarSuggestion("{{campaignIds}}")).toBe("campaignId");
    expect(itemVarSuggestion("companies")).toBe("company");
  });

  it("says nothing rather than guessing wrong", () => {
    // A suggestion that is usually wrong trains people to ignore the ones that are right,
    // and these are the words the naive rule mangles.
    expect(itemVarSuggestion("status")).toBeUndefined();
    expect(itemVarSuggestion("address")).toBeUndefined();
    expect(itemVarSuggestion("launched")).toBeUndefined();
    expect(itemVarSuggestion("")).toBeUndefined();
  });
});

describe("what a step carries forward", () => {
  const fields = [
    { name: "campaignId", path: "$.data.campaignId" },
    { name: "txnId", path: "$.data.txnId" },
  ];

  it("names both fields and the record they travel in", () => {
    // The point of the record shape: the two arrive together, so a later step gets *its*
    // txnId rather than whichever one happened to be at the same index.
    const line = collectionSummary("launched", fields);
    expect(line).toContain("launched");
    expect(line).toContain("campaignId, txnId");
    expect(line).toContain("one record");
  });

  it("names the condition in the summary, so what is skipped is visible", () => {
    // Passing is not the same as producing: a 400 that was expected passes and created nothing.
    const line = collectionSummary("launched", fields, "response.status == 202");
    expect(line).toContain("when response.status == 202");
    expect(line).toContain("campaignId, txnId");
  });

  it("says nothing about a condition that isn't set", () => {
    expect(collectionSummary("launched", fields, "  ")).not.toContain("when");
  });

  it("says where fields with nowhere to go should be put", () => {
    // The old silent failure: captures that resolve to nothing, whose only symptom was
    // {{name}} arriving literally at a later step.
    expect(collectionSummary("", fields)).toContain("need a list to be collected into");
  });

  it("says nothing is collected yet, points at where a field is added, and says what it buys", () => {
    // All three, because dropping any one of them has cost something. Without "below" it repeated
    // the empty row underneath word for word and neither said where the Add button was. Without
    // the present tense it described only the future, so a step with "Collect into" and no fields
    // read as configured — one real flow ran that way, collected nothing, and failed two steps
    // later with "No variable named launched".
    const line = collectionSummary("launched", []);
    expect(line).toMatch(/Nothing is collected yet/i);
    expect(line).toMatch(/will not exist/i);
    expect(line).toContain("below");
    expect(line).toContain("one record");
    expect(line).toContain("launched");
  });

  it("ignores half-filled rows when listing the fields", () => {
    expect(collectionSummary("launched", [{ name: "  ", path: "$.x" }])).toMatch(
      /add a field below/i,
    );
  });

  it("is plain about a step that carries nothing", () => {
    expect(collectionSummary("", [])).toContain("Nothing is carried forward");
  });
});

describe("what a step that walks a list says", () => {
  it("names the element variable when the list holds plain values", () => {
    expect(walkSummary("things", "id", ["things"])).toContain("{{id}}");
  });

  it("explains that a record's fields keep their own names", () => {
    expect(walkSummary("launched", "", ["launched"])).toContain(
      "under the names they were collected with",
    );
  });

  it("doubts a name no earlier step collects, without calling it wrong", () => {
    // A script or a project variable can hold a list too, so this is a doubt and not an
    // error — but a typo is far likelier, and saying nothing is how it reaches a run.
    const line = walkSummary("lanched", "", ["launched"]);
    expect(line).toContain("no earlier step in this flow collects that name");
  });

  it("asks for a list when there isn't one", () => {
    expect(walkSummary("", "", [])).toContain("Pick the list to walk");
  });
});

describe("the canvas badge", () => {
  it("says which list a step walks", () => {
    expect(walkBadge({ forEach: { list: "{{launched}}" } })).toBe("per launched");
  });

  it("is absent for every other kind of step", () => {
    expect(walkBadge({ forEachRow: true })).toBeUndefined();
    expect(walkBadge({})).toBeUndefined();
    expect(walkBadge(undefined)).toBeUndefined();
  });
});

describe("a step that waits for a callback", () => {
  it("says how long it waits and what happens when nothing comes", () => {
    // The timeout is the field an author gets wrong, and the failure it produces reads "no
    // callback arrived" — indistinguishable from a sender that never called. So the panel
    // states the wait, and states that the flow takes its failure edge.
    const line = awaitSummary({ path: "dr/jt1", count: 1, timeoutMs: 30000 });
    expect(line).toContain("30s");
    expect(line).toContain("one callback");
    expect(line).toContain("dr/jt1");
    expect(line).toMatch(/fails/);
  });

  it("counts plural callbacks in words, not as a bare number", () => {
    expect(awaitSummary({ path: "dr/x", count: 2 })).toContain("2 callbacks");
  });

  it("asks for the path when there isn't one, because it cannot run without it", () => {
    expect(awaitSummary({ count: 1 })).toMatch(/cannot run/);
    expect(awaitSummary(undefined)).toMatch(/cannot run/);
  });

  it("reads a 0 as a cleared field, matching the engine", () => {
    // "Wait for no callbacks" and "give up after no time" are not things an author can mean, so
    // a 0 has to show as what it will behave as — or the panel and the engine disagree.
    const line = awaitSummary({ path: "dr/x", count: 0, timeoutMs: 0 });
    expect(line).toContain("one callback");
    expect(line).toContain(`${AWAIT_TIMEOUT_MS / 1000}s`);
  });

  it("badges the canvas node with how many and for how long", () => {
    expect(awaitBadge({ count: 2, timeoutMs: 45000 })).toBe("2 · 45s");
    expect(awaitBadge(undefined)).toBe(`1 · ${AWAIT_TIMEOUT_MS / 1000}s`);
  });
});

describe("a path that takes the whole response", () => {
  it("says what $ actually captures, and that nothing else will tell you", () => {
    // The compounding part: every other wrong path produces "nothing at $.foo — {{name}} will
    // not resolve" at run time. `$` always matches, so it is the one wrong path with no
    // downstream warning at all. This is the only place it can be said.
    const note = rootPathWarning("$", "campaign_info", "once")!;
    expect(note).toContain("entire body");
    expect(note).toMatch(/always succeeds/);
    expect(note).toContain("$.campaignId");
  });

  it("explains the dots, which is why the blob cannot be used", () => {
    // {{campaign_info.campaignId}} is not something interpolation can resolve — the regex has
    // no dots — so the captured object is unreachable and pastes in whole.
    expect(rootPathWarning("$", "campaign_info", "once")).toContain("no dots");
  });

  it("says the collection version for a step that runs more than once", () => {
    const note = rootPathWarning("$", "campaign_info", "rows")!;
    expect(note).toMatch(/one field containing everything/);
    expect(note).toMatch(/walking the list/);
  });

  it("treats $. the same as $", () => {
    expect(rootPathWarning("$.", "x", "once")).toBeDefined();
    expect(rootPathWarning("  $  ", "x", "once")).toBeDefined();
  });

  it("leaves a recursive-descent query alone, which is a real query", () => {
    // `$..campaignId` matches fields, not the root. Warning about it would be wrong.
    expect(rootPathWarning("$..campaignId", "x", "once")).toBeUndefined();
  });

  it("says nothing about an ordinary path", () => {
    expect(rootPathWarning("$.campaignId", "x", "once")).toBeUndefined();
    expect(rootPathWarning("$.data.items[0].id", "x", "items")).toBeUndefined();
    expect(rootPathWarning("", "x", "once")).toBeUndefined();
  });

  it("copes with an unnamed row, which is how one is added", () => {
    // The + button adds a blank row, so the path can be typed before the name.
    expect(rootPathWarning("$", "", "once")).toContain("this variable");
  });
});

describe("checking the list a wait is told to walk", () => {
  it("confirms a name an earlier step collects", () => {
    const check = awaitListCheck("sent", ["sent", "launched"]);
    expect(check.state).toBe("collected");
    expect(check.text).toContain('"sent"');
  });

  it("forgives braces, as the engine does", () => {
    expect(awaitListCheck("{{sent}}", ["sent"]).state).toBe("collected");
  });

  it("doubts an unknown name rather than calling it wrong", () => {
    // A project variable, a flow variable or a SAT.vars write can hold a list, and only run time
    // knows. Saying "wrong" about a name that turns out to be right teaches an author to ignore
    // the panel, which costs more than the typo it caught.
    const check = awaitListCheck("typo", ["sent"]);
    expect(check.state).toBe("unknown");
    expect(check.text).toMatch(/can still be right/i);
  });

  it("asks for a name when there is none, which is the one hard error", () => {
    expect(awaitListCheck("", ["sent"]).state).toBe("missing");
    expect(awaitListCheck("  {{}}  ", ["sent"]).state).toBe("missing");
  });

  it("doubts everything when nothing upstream collects at all", () => {
    expect(awaitListCheck("sent", []).state).toBe("unknown");
  });
});

describe("the URL a payload has to send", () => {
  it("states it, rather than asking the author to restate it", () => {
    // The field used to ask for "the tail of the URL your test puts in its payload", which is
    // circular: you cannot fill it *from* the payload before the payload exists, and you cannot
    // write the payload before choosing a name. Inverted, there is no puzzle.
    expect(callbackUrlToSend("dr/{{dr_path}}")).toBe("{{hook_base}}/dr/{{dr_path}}");
  });

  it("says nothing while there is no name yet", () => {
    expect(callbackUrlToSend("")).toBe("");
    expect(callbackUrlToSend("   ")).toBe("");
  });

  it("does not double the slash when the name starts with one", () => {
    expect(callbackUrlToSend("/dr/x")).toBe("{{hook_base}}/dr/x");
  });
});

describe("what a waiting step counts", () => {
  it("counts against the budget", () => {
    expect(awaitProgress(12, 60000)).toBe("12s / 60s");
  });

  it("keeps the denominator true by bounding the step at one budget", () => {
    // This briefly showed "70s / 60s" on a step doing exactly what it was told: waits ran item by
    // item, so the real total was items × budget. Running them together made the label honest
    // again — the fix belonged in the engine, not in the wording.
    expect(awaitProgress(70, 60000)).toBe("70s / 60s");
  });
});
