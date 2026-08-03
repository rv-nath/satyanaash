import { describe, it, expect } from "vitest";
import { applyHeaderSuggestion, type HeaderRow } from "@/components/HeadersEditor";

const row = (over: Partial<HeaderRow> = {}): HeaderRow => ({
  id: "h1",
  key: "",
  value: "",
  enabled: true,
  ...over,
});

describe("picking a header from the typeahead", () => {
  it("sets the name — which is what it used to lose", () => {
    // The bug: two sequential updates each mapped over the headers array captured by that
    // render, so the second discarded the first. Every COMMON_HEADERS entry has an example,
    // so the value branch always fired and the *name* was always the casualty. You picked
    // Authorization, got "Bearer {{token}}", and an empty key.
    const [header] = applyHeaderSuggestion([row()], 0, "Authorization");
    expect(header.key).toBe("Authorization");
    expect(header.value).toBe("Bearer {{token}}");
  });

  it("keeps a value the author already typed", () => {
    const [header] = applyHeaderSuggestion([row({ value: "Bearer mine" })], 0, "Authorization");
    expect(header.key).toBe("Authorization");
    expect(header.value).toBe("Bearer mine");
  });

  it("sets the name even for a header nobody suggested", () => {
    const [header] = applyHeaderSuggestion([row()], 0, "X-Correlation-Id");
    expect(header.key).toBe("X-Correlation-Id");
    expect(header.value).toBe("");
  });

  it("touches only the row that was picked into", () => {
    const before = [row({ id: "a", key: "Accept", value: "*/*" }), row({ id: "b" })];
    const after = applyHeaderSuggestion(before, 1, "Content-Type");
    expect(after[0]).toEqual(before[0]);
    expect(after[1].key).toBe("Content-Type");
  });

  it("hands back the same array when there is no such row", () => {
    // So the caller can skip a pointless state update rather than re-rendering over nothing.
    const before = [row()];
    expect(applyHeaderSuggestion(before, 9, "Accept")).toBe(before);
  });
});
