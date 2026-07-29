import { describe, it, expect } from "vitest";
import {
  canvasNodeName,
  completedCount,
  executionClassFor,
  exportLines,
  nodeExecState,
} from "@/lib/executionDecor";
import type { TestCaseExecutionResult } from "@/lib/api/types";

const result = (status: TestCaseExecutionResult["status"]): TestCaseExecutionResult =>
  ({ node_id: "n1", status, duration_ms: 12 }) as TestCaseExecutionResult;

const view = (over: Partial<Parameters<typeof nodeExecState>[1]> = {}) => ({
  activeNodeId: null,
  pausedNodeId: null,
  runs: undefined,
  ...over,
});

describe("nodeExecState", () => {
  it("says nothing about a node that hasn't run", () => {
    expect(nodeExecState("n1", view())).toBeUndefined();
    expect(executionClassFor("n1", view())).toBe("");
  });

  it("maps each verdict to its own class", () => {
    const runs = {
      ok: result("passed"),
      bad: result("failed"),
      broke: result("error"),
      never: result("skipped"),
    };
    expect(executionClassFor("ok", view({ runs }))).toBe("exec-passed");
    expect(executionClassFor("bad", view({ runs }))).toBe("exec-failed");
    expect(executionClassFor("broke", view({ runs }))).toBe("exec-error");
    expect(executionClassFor("never", view({ runs }))).toBe("exec-skipped");
  });

  it("prefers the request in flight over what the node did earlier", () => {
    // A node re-run in a later pass is more interesting than its previous verdict.
    const v = view({ activeNodeId: "n1", runs: { n1: result("failed") } });
    expect(nodeExecState("n1", v)).toBe("running");
  });

  it("marks the node a paused run is waiting to run", () => {
    expect(executionClassFor("n2", view({ pausedNodeId: "n2" }))).toBe("exec-next");
    // And leaves the ones already done alone.
    const v = view({ pausedNodeId: "n2", runs: { n1: result("passed") } });
    expect(executionClassFor("n1", v)).toBe("exec-passed");
  });
});

describe("completedCount", () => {
  it("counts the nodes that finished, and copes with a flow that hasn't run", () => {
    expect(completedCount(undefined)).toBe(0);
    expect(completedCount({ a: result("passed"), b: result("failed") })).toBe(2);
  });
});

describe("canvasNodeName", () => {
  const nodes = [
    { id: "n1", data: { label: "Login", alias: "Login as PA" } },
    { id: "n2", data: { label: "Delete user" } },
    { id: "n3", data: { label: "Blank", alias: "   " } },
    { id: "n4" },
  ];

  it("prefers the author's alias, as the log does", () => {
    expect(canvasNodeName(nodes, "n1")).toBe("Login as PA");
  });

  it("falls back to the label, then to the id", () => {
    expect(canvasNodeName(nodes, "n2")).toBe("Delete user");
    expect(canvasNodeName(nodes, "n3")).toBe("Blank"); // whitespace is not a name
    expect(canvasNodeName(nodes, "n4")).toBe("n4");
    expect(canvasNodeName(nodes, "missing")).toBe("missing");
  });
});

describe("exportLines", () => {
  it("has nothing to say when a node exported nothing", () => {
    expect(exportLines(undefined)).toEqual([]);
    expect(exportLines({})).toEqual([]);
  });

  it("cuts a long value short and says how long it was", () => {
    // The case that prompted the cap: a JWT would fill the popover on its own.
    const jwt = "e".repeat(2474);
    const [line] = exportLines({ my_jwt: jwt });
    expect(line.name).toBe("my_jwt");
    expect(line.value).toBe(`${"e".repeat(44)}… (2474 chars)`);
  });

  it("leaves a short value exactly as it is", () => {
    expect(exportLines({ user_id: "42" })).toEqual([{ name: "user_id", value: "42" }]);
  });

  it("flattens a value that isn't a string onto one line", () => {
    expect(exportLines({ n: 3 })).toEqual([{ name: "n", value: "3" }]);
    expect(exportLines({ o: { a: 1 } })).toEqual([{ name: "o", value: '{"a":1}' }]);
  });
});
