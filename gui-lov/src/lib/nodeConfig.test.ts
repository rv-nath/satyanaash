import { describe, it, expect } from "vitest";
import {
  collectionSummary,
  itemVarSuggestion,
  listName,
  runModeOf,
  stripBraces,
  walkBadge,
  walkSummary,
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

  it("points at where a field is added, and says what it buys", () => {
    // Not "has no fields yet": that repeated the empty row underneath it word for word, and
    // between the two of them neither said where the Add button was.
    const line = collectionSummary("launched", []);
    expect(line).toContain("below");
    expect(line).toContain("one record");
    expect(line).toContain("launched");
  });

  it("ignores half-filled rows when listing the fields", () => {
    expect(collectionSummary("launched", [{ name: "  ", path: "$.x" }])).toContain(
      "Add a field below",
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
