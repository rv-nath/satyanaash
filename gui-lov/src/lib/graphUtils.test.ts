/**
 * The edge round-trip.
 *
 * This file did not exist, and that is the whole story of the bug it now pins. `edgesToApi` sent
 * `edge_type` — the Rust *field* name — where the wire key is `type`, because `GraphEdge` carries
 * `#[serde(rename = "type")]`. Serde ignored the unknown field, so the edge saved and came back
 * untyped. The inbound half never read the type at all, so it was lost on load as well.
 *
 * Nothing failed. The canvas asks which kind of edge you are drawing, colours a failure edge and
 * labels it, and both were discarded on save — so **no failure edge drawn on the canvas ever
 * survived a reload**. And because `useAutoValidate` sends this same shape, the validator was told
 * those graphs had no failure edge and warned `NO_FAILURE_EDGE` about ones that did. Two symptoms
 * that looked unrelated, one wrong key, and no test in between.
 *
 * So the tests here are written against the **wire**, not against the pair of functions: a
 * round-trip test alone would have passed happily with `edge_type` at both ends.
 */
import { describe, it, expect } from "vitest";
import type { Edge } from "@xyflow/react";
import { edgesFromApi, edgesToApi } from "@/lib/graphUtils";
import type { FlowEdge } from "@/lib/api/types";

const canvasEdge = (over: Partial<Edge> = {}): Edge => ({
  id: "e1",
  source: "a",
  target: "b",
  ...over,
});

describe("edgesToApi", () => {
  it("names the type `type`, which is what the server calls it on the wire", () => {
    // The bug, stated as a key. `edge_type` is the Rust field name; serde renames it.
    const [sent] = edgesToApi([canvasEdge({ data: { type: "failure" } })]);
    expect(sent.type).toBe("failure");
    expect(Object.keys(sent)).not.toContain("edge_type");
  });

  it("puts the label in the edge's data bag, the only place the server keeps one", () => {
    // `GraphEdge` has no top-level `label`, so one sent there was dropped exactly like the type —
    // and the canvas labels every typed edge, so the label vanished too.
    const [sent] = edgesToApi([canvasEdge({ data: { type: "failure" }, label: "Failure" })]);
    expect(sent.data).toEqual({ label: "Failure" });
    expect(Object.keys(sent)).not.toContain("label");
  });

  it("omits both rather than sending undefined, so an untyped edge's JSON does not churn", () => {
    const [sent] = edgesToApi([canvasEdge()]);
    expect(Object.keys(sent).sort()).toEqual(["id", "source", "target"]);
  });
});

describe("edgesFromApi", () => {
  it("reads the type off the wire and puts it where the canvas looks for it", () => {
    // The inbound half of the same bug: this mapped id/source/target/label by hand and never
    // read the type, so fixing only the outbound side would have looked right once and then
    // lost the type on the next save.
    const [edge] = edgesFromApi([{ id: "e1", source: "a", target: "b", type: "failure" }]);
    expect(edge.data).toEqual({ type: "failure" });
  });

  it("brings the label back out of the data bag onto React Flow's own prop", () => {
    const [edge] = edgesFromApi([
      { id: "e1", source: "a", target: "b", type: "failure", data: { label: "Failure" } },
    ]);
    expect(edge.label).toBe("Failure");
  });

  it("remaps source and target when a duplicate id was found on load", () => {
    const [edge] = edgesFromApi([{ id: "e1", source: "a", target: "b" }], (id) =>
      id === "a" ? "a-2" : id,
    );
    expect([edge.source, edge.target]).toEqual(["a-2", "b"]);
  });

  it("has nothing to say about a flow with no edges", () => {
    expect(edgesFromApi(undefined)).toEqual([]);
    expect(edgesFromApi([])).toEqual([]);
  });
});

describe("the Always edge", () => {
  it("round-trips like the other kinds", () => {
    const [reloaded] = edgesFromApi(
      edgesToApi([canvasEdge({ data: { type: "any" }, label: "Always" })]),
    );
    expect(reloaded.data).toEqual({ type: "any" });
    expect(reloaded.label).toBe("Always");
  });

  it("is a distinct type, not a synonym for untyped", () => {
    // The difference is the whole point: an untyped edge is never taken on a failure, so it
    // cannot stand in for Always. Collapsing them would silently change how seven existing
    // flows route a failed step.
    const [typed] = edgesToApi([canvasEdge({ data: { type: "any" } })]);
    const [untyped] = edgesToApi([canvasEdge()]);
    expect(typed.type).toBe("any");
    expect(untyped.type).toBeUndefined();
  });
});

describe("an edge's type survives the round trip", () => {
  it("comes back the same after save and load", () => {
    const drawn = canvasEdge({ data: { type: "failure" }, label: "Failure" });
    const [reloaded] = edgesFromApi(edgesToApi([drawn]));
    expect(reloaded.data).toEqual({ type: "failure" });
    expect(reloaded.label).toBe("Failure");
  });

  it("survives being saved and loaded repeatedly, which is what autosave does", () => {
    // One round trip can hide a bug that only bites on the second: the type was dropped on load,
    // so the *first* save after opening a flow was what destroyed it.
    let edges = [canvasEdge({ data: { type: "failure" }, label: "Failure" })];
    for (let i = 0; i < 3; i++) edges = edgesFromApi(edgesToApi(edges));
    expect(edges[0].data).toEqual({ type: "failure" });
    expect(edges[0].label).toBe("Failure");
  });

  it("keeps an untyped edge untyped, rather than inventing a default", () => {
    // Every edge in the author's real flows is untyped, and a default of "success" would give
    // `failure_edge` something to find and change how a failed node routes.
    const [reloaded] = edgesFromApi(edgesToApi([canvasEdge()]));
    expect(reloaded.data).toBeUndefined();
    expect(reloaded.label).toBeUndefined();
  });

  it("matches the shape the server actually stores", () => {
    // Written out longhand, because this is the contract that was wrong. If `GraphEdge` is ever
    // renamed again, this is the test that should fail.
    const wire: FlowEdge = {
      id: "e2f",
      source: "list",
      target: "users",
      type: "failure",
      data: { label: "Failure" },
    };
    expect(edgesToApi(edgesFromApi([wire]))).toEqual([wire]);
  });
});
