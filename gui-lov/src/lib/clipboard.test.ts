import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { copyText } from "@/lib/clipboard";

describe("copyText", () => {
  const original = navigator.clipboard;

  const setClipboard = (value: unknown) =>
    Object.defineProperty(navigator, "clipboard", { value, configurable: true });

  beforeEach(() => {
    // jsdom has no execCommand at all.
    (document as unknown as { execCommand: unknown }).execCommand = vi.fn(() => true);
  });

  afterEach(() => setClipboard(original));

  it("uses the clipboard API when it exists", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    expect(await copyText("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it("falls back when there is no clipboard API — a plain-http origin", async () => {
    setClipboard(undefined);
    expect(await copyText("hello")).toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("falls back when the clipboard API refuses", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    expect(await copyText("hello")).toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("reports failure rather than pretending, and leaves no stray node behind", async () => {
    setClipboard(undefined);
    (document as unknown as { execCommand: unknown }).execCommand = vi.fn(() => false);
    expect(await copyText("hello")).toBe(false);
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });
});
