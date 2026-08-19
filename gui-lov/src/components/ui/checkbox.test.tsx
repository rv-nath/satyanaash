/**
 * The checkbox's third state.
 *
 * Radix has always accepted `checked="indeterminate"`, so a caller could ask for it and get a box
 * that was **empty and unfilled** — indistinguishable from unchecked. A section header speaking for
 * fourteen rows, nine ticked, would have read as "none".
 *
 * Tested here rather than through a caller because the failure is invisible from there: the
 * consumer's tests assert Radix's `data-state`, which is set whether or not anything is drawn.
 * Removing the styling breaks nothing they can see.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Checkbox } from "@/components/ui/checkbox";

describe("Checkbox in the indeterminate state", () => {
  it("is filled, like a ticked one — not left looking empty", () => {
    render(<Checkbox checked="indeterminate" aria-label="some" />);
    const box = screen.getByLabelText("some");
    expect(box).toHaveAttribute("data-state", "indeterminate");
    expect(box.className).toContain("data-[state=indeterminate]:bg-primary");
    expect(box.className).toContain("data-[state=indeterminate]:text-primary-foreground");
  });

  it("draws a dash rather than a tick, because 'some of these' is not 'yes'", () => {
    // A tick over a partial selection invites you to believe the whole section is in.
    const { container } = render(<Checkbox checked="indeterminate" aria-label="some" />);
    expect(container.querySelector(".lucide-minus")).not.toBeNull();
    expect(container.querySelector(".lucide-check")).toBeNull();
  });

  it("still draws a tick when fully checked", () => {
    const { container } = render(<Checkbox checked aria-label="all" />);
    expect(container.querySelector(".lucide-check")).not.toBeNull();
    expect(container.querySelector(".lucide-minus")).toBeNull();
  });

  it("shows nothing when unchecked, as before", () => {
    const { container } = render(<Checkbox checked={false} aria-label="none" />);
    // Radix hides the indicator entirely, so neither icon is in the tree.
    expect(container.querySelector(".lucide-minus")).toBeNull();
    expect(container.querySelector(".lucide-check")).toBeNull();
  });
});
