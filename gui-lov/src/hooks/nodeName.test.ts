import { describe, it, expect } from "vitest";
import { nodeName } from "@/hooks/useExecutionStream";

describe("nodeName", () => {
  const base = { node_id: "n1", test_case_id: "tc1", test_case_name: "Login" };

  it("prefers the name the author gave the node", () => {
    expect(nodeName({ ...base, node_label: "Root login" })).toBe("Root login");
  });

  it("tells two nodes running one test case apart", () => {
    const asUser = nodeName({ ...base, node_label: "Login as new user" });
    const asRoot = nodeName({ ...base, node_id: "n2", node_label: "Root login" });
    expect(asUser).not.toBe(asRoot);
  });

  it("falls back to the test case when the node is unnamed", () => {
    expect(nodeName(base)).toBe("Login");
    // A blank name is not a name — it must not blank out the log line.
    expect(nodeName({ ...base, node_label: "   " })).toBe("Login");
  });

  it("still says something when nothing is named", () => {
    expect(nodeName({ node_id: "n1" })).toBe("n1");
    expect(nodeName({ node_id: "n1", test_case_id: "tc1" })).toBe("tc1");
  });
});
