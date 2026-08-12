import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  canvasNodeName,
  completedCount,
  executionClassFor,
  collectedByRow,
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

describe("collectedByRow", () => {
  const row = (label: string) => ({ row_label: label });

  it("pairs each record with the row that produced it", () => {
    const result = collectedByRow({
      iterations: [row("first"), row("second")],
      exports: { launched: [{ id: "a", _row: "first" }, { id: "b", _row: "second" }] },
    });
    expect(result.byRow.get(0)).toMatchObject({ id: "a" });
    expect(result.byRow.get(1)).toMatchObject({ id: "b" });
    expect(result.unclaimed).toEqual([]);
  });

  it("skips rows that contributed nothing", () => {
    // The normal case in a mixed dataset: a negative row expecting a 400 passes and has no id.
    const result = collectedByRow({
      iterations: [row("positive"), row("negative"), row("also positive")],
      exports: { launched: [{ id: "a", _row: "positive" }, { id: "c", _row: "also positive" }] },
    });
    expect(result.byRow.get(0)).toMatchObject({ id: "a" });
    expect(result.byRow.has(1)).toBe(false);
    expect(result.byRow.get(2)).toMatchObject({ id: "c" });
  });

  it("keeps two rows with the same name apart", () => {
    // The reason this zips instead of looking up by `_row`: nothing stops two rows sharing a
    // name, and a lookup would hand both of them the first record — pairing an id with a row
    // that did not produce it, which is worse than showing nothing.
    const result = collectedByRow({
      iterations: [row("same"), row("same")],
      exports: { launched: [{ id: "a", _row: "same" }, { id: "b", _row: "same" }] },
    });
    expect(result.byRow.get(0)).toMatchObject({ id: "a" });
    expect(result.byRow.get(1)).toMatchObject({ id: "b" });
  });

  it("reports a record no row claimed rather than dropping it", () => {
    const result = collectedByRow({
      iterations: [row("here")],
      exports: { launched: [{ id: "x", _row: "somewhere else" }] },
    });
    expect(result.byRow.size).toBe(0);
    expect(result.unclaimed).toHaveLength(1);
  });

  it("is empty when nothing was collected", () => {
    expect(collectedByRow({ iterations: [row("a")] }).byRow.size).toBe(0);
    expect(collectedByRow({}).unclaimed).toEqual([]);
  });
});

describe("the stylesheet keeps the classes this file computes", () => {
  /**
   * Tailwind purges rules inside an `@layer` directive whose class names it cannot find in its
   * content scan. Every class here is built at runtime — `exec-${state}` — so none of them is a
   * literal string anywhere it looks.
   *
   * `.exec-running` was stripped from the stylesheet for exactly that reason and the "running"
   * pulse never rendered, for any node type, for as long as the rule existed. `exec-passed`,
   * `exec-failed` and `exec-next` survived only because they appear as literal strings *in this
   * test file*, which sits inside the content glob — so deleting these tests would have silently
   * broken the decorations they were testing. That is the trap this guards.
   */
  // From the project root, because `import.meta.url` is an http URL under the jsdom
  // environment and `readFileSync` refuses it.
  const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

  /** Every node-decoration rule, with whether it sits inside an @layer block. */
  const decorationRules = () => {
    const out: { selector: string; layered: boolean }[] = [];
    let depth = 0;
    const layerDepth: number[] = [];
    for (const line of css.split("\n")) {
      if (/^\s*@layer\b[^;]*\{/.test(line)) layerDepth.push(depth);
      const m = line.match(/(\.react-flow__node\.[\w-]+)/);
      if (m) out.push({ selector: m[1], layered: layerDepth.length > 0 });
      depth += (line.match(/\{/g) || []).length;
      const closes = (line.match(/\}/g) || []).length;
      for (let i = 0; i < closes; i++) {
        depth -= 1;
        if (layerDepth.length && depth === layerDepth[layerDepth.length - 1]) layerDepth.pop();
      }
    }
    return out;
  };

  it("declares every node decoration outside @layer, where Tailwind cannot purge it", () => {
    const layered = decorationRules().filter((r) => r.layered).map((r) => r.selector);
    expect(layered).toEqual([]);
  });

  it("still has a rule for each state this file can return", () => {
    // A state with no rule renders nothing at all — which is the bug, just from the other side.
    const selectors = decorationRules().map((r) => r.selector);
    for (const state of ["running", "next", "passed", "failed", "error", "skipped"]) {
      expect(selectors).toContain(`.react-flow__node.exec-${state}`);
    }
  });
});
