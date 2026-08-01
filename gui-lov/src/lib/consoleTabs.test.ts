import { describe, it, expect } from "vitest";
import { consoleTabsFor, isSuiteLogKey, shownConsole, suiteIdFromLogKey } from "@/lib/consoleTabs";
import { suiteLogKey } from "@/lib/runHistory";

const flows = [
  { id: "f1", name: "Launch a campaign" },
  { id: "f2", name: "Check my balance" },
];
const suites = [{ id: "s1", name: "Regression" }];

const build = (over: Partial<Parameters<typeof consoleTabsFor>[0]> = {}) =>
  consoleTabsFor({
    logKeys: [],
    flows,
    suites,
    entryCount: () => 3,
    ...over,
  });

describe("a suite's console", () => {
  it("gets a tab, which is the bug that hid every suite run", () => {
    // The list used to be built by filtering the flow rail, so a `suite:<id>` key was
    // dropped: the output was collected and stored, and the panel had nowhere to show it.
    // You pressed Run, the API streamed, and the screen said nothing.
    const tabs = build({ logKeys: [suiteLogKey("s1")] });
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).toBe("suite:s1");
    expect(tabs[0].name).toBe("Regression");
    expect(tabs[0].entries).toBe(3);
  });

  it("is named after the suite, not its key", () => {
    const tabs = build({ logKeys: [suiteLogKey("s1")] });
    expect(tabs[0].name).not.toContain("suite:");
  });

  it("reports itself as running", () => {
    const key = suiteLogKey("s1");
    const tabs = build({ logKeys: [key], executingId: key });
    expect(tabs[0].running).toBe(true);
  });

  it("appears for the suite on screen even before it has run", () => {
    // Otherwise the panel is headless the first time you open a suite, which reads as
    // broken rather than as empty.
    const tabs = build({ activeSuiteKey: suiteLogKey("s1") });
    expect(tabs.map((t) => t.id)).toEqual(["suite:s1"]);
  });
});

describe("flows and suites together", () => {
  it("keeps flows in rail order, then suites", () => {
    const tabs = build({ logKeys: ["f2", suiteLogKey("s1"), "f1"] });
    expect(tabs.map((t) => t.id)).toEqual(["f1", "f2", "suite:s1"]);
  });

  it("still shows the flow on screen with no output", () => {
    const tabs = build({ activeFlowId: "f1" });
    expect(tabs.map((t) => t.id)).toEqual(["f1"]);
  });
});

describe("output whose producer is gone", () => {
  it("is shown rather than dropped", () => {
    // A flow deleted mid-session still has its log in memory. Filtering it out is how the
    // suite bug happened in the first place, so nothing is filtered out any more.
    const tabs = build({ logKeys: ["deleted-flow", suiteLogKey("deleted-suite")] });
    expect(tabs.map((t) => t.name)).toEqual(["Flow (deleted)", "Suite (deleted)"]);
  });
});

describe("shownConsole", () => {
  it("keeps the pinned console while it exists, else falls to the first", () => {
    const tabs = build({ logKeys: ["f1", "f2"] });
    expect(shownConsole(tabs, "f2")).toBe("f2");
    expect(shownConsole(tabs, "gone")).toBe("f1");
    expect(shownConsole([], "f1")).toBeNull();
  });
});

describe("suite log keys", () => {
  it("round-trip, and cannot be confused with a flow id", () => {
    expect(isSuiteLogKey(suiteLogKey("s1"))).toBe(true);
    expect(isSuiteLogKey("f1")).toBe(false);
    expect(suiteIdFromLogKey(suiteLogKey("s1"))).toBe("s1");
  });
});
