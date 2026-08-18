/**
 * The connection-type dialog.
 *
 * It offered two choices for as long as the engine had two verdicts to route on — and "carry on
 * either way" had to be drawn as two edges to the same target, which overlap exactly on the canvas
 * and so showed one line where two existed. The third option is that missing primitive.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EdgeTypeDialog } from "@/components/EdgeTypeDialog";

describe("EdgeTypeDialog", () => {
  it("offers all three kinds of edge", () => {
    render(<EdgeTypeDialog open onSelect={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText("Success Path")).toBeInTheDocument();
    expect(screen.getByText("Failure Path")).toBeInTheDocument();
    expect(screen.getByText("Always")).toBeInTheDocument();
  });

  it("reads Always last, because it is the least specific of the three", () => {
    render(<EdgeTypeDialog open onSelect={vi.fn()} onCancel={vi.fn()} />);
    const labels = screen
      .getAllByRole("button")
      .map((b) => b.textContent ?? "")
      .filter((t) => /Success Path|Failure Path|Always/.test(t));
    expect(labels[2]).toContain("Always");
  });

  it("says that the run still fails, which is the question Always raises", () => {
    // An edge that continues past a red step invites exactly one worry, so the option answers it
    // where it is read rather than in documentation.
    render(<EdgeTypeDialog open onSelect={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/the run still fails if it failed/i)).toBeInTheDocument();
  });

  it("keeps every option inside the dialog, however long its description", () => {
    // `Button`'s base class is `whitespace-nowrap`, so a description could not wrap and the widest
    // of the three set the width for all of them — overflowing `sm:max-w-md` well past the dialog's
    // edge. Latent from the start; the third option's caveat is what made it visible.
    render(<EdgeTypeDialog open onSelect={vi.fn()} onCancel={vi.fn()} />);
    for (const label of ["Success Path", "Failure Path", "Always"]) {
      const button = screen.getByText(label).closest("button")!;
      expect(button.className).toContain("whitespace-normal");
      expect(button.className).toContain("w-full");
    }
  });

  it("lets the text column shrink, which is what actually permits the wrap", () => {
    // A flex item defaults to `min-width: auto` and refuses to go below its content, so
    // `whitespace-normal` alone would not have been enough.
    render(<EdgeTypeDialog open onSelect={vi.fn()} onCancel={vi.fn()} />);
    const column = screen.getByText("Always").parentElement!;
    expect(column.className).toContain("min-w-0");
  });

  it("reports the type the engine stores, not the word on the button", () => {
    const onSelect = vi.fn();
    render(<EdgeTypeDialog open onSelect={onSelect} onCancel={vi.fn()} />);
    return userEvent.click(screen.getByText("Always")).then(() => {
      expect(onSelect).toHaveBeenCalledWith("any");
    });
  });
});
