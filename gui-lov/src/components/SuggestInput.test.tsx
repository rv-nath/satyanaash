import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SuggestInput } from "@/components/SuggestInput";

const setup = (props: Partial<React.ComponentProps<typeof SuggestInput>> = {}) => {
  const onAccept = vi.fn();
  const onChange = vi.fn();
  const { unmount } = render(
    <SuggestInput
      aria-label="Endpoint"
      value=""
      suggestion="http://127.0.0.1:9000"
      onAccept={onAccept}
      onChange={onChange}
      {...props}
    />,
  );
  return { onAccept, onChange, unmount, field: screen.getByLabelText("Endpoint") };
};

describe("accepting a suggestion", () => {
  it("takes it on Tab, → and End", async () => {
    for (const key of ["{Tab}", "{ArrowRight}", "{End}"]) {
      const { onAccept, field, unmount } = setup();
      await userEvent.click(field);
      await userEvent.keyboard(key);
      expect(onAccept, `${key} should accept`).toHaveBeenCalledWith("http://127.0.0.1:9000");
      // Torn down between keys so each one gets a fresh field rather than three stacked in
      // the document — `getByLabelText` would then find several and throw.
      unmount();
    }
  });

  it("does not move focus when Tab accepts", async () => {
    // Accepting and leaving in one press would make the fill invisible — nobody would know
    // which field had just changed.
    const { field } = setup();
    await userEvent.click(field);
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(field);
  });

  it("leaves the keys alone once something is typed", async () => {
    // → and End have to mean what they always mean inside text, and a Tab that rewrote what
    // someone was halfway through typing would be indefensible.
    const { onAccept, field } = setup({ value: "http://my" });
    await userEvent.click(field);
    await userEvent.keyboard("{ArrowRight}{End}");
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("does nothing when there is no suggestion, only an example", async () => {
    // The distinction the whole component exists for: filling in an example gives you a
    // storage genuinely called "minio (dev)".
    const { onAccept, field } = setup({ suggestion: undefined, placeholder: "minio (dev)" });
    await userEvent.click(field);
    await userEvent.keyboard("{Tab}");
    expect(onAccept).not.toHaveBeenCalled();
    expect(field).toHaveAttribute("placeholder", "minio (dev)");
  });

  it("lets Escape dismiss it, so Tab can leave a field blank", async () => {
    const { onAccept, field } = setup();
    await userEvent.click(field);
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{Tab}");
    expect(onAccept).not.toHaveBeenCalled();
    // Tab now does what Tab does.
    expect(document.activeElement).not.toBe(field);
  });

  it("shows the hint without waiting to be focused", async () => {
    // The failure this fixes: on focus alone the badge was invisible to someone scanning a
    // filled-in form — exactly when it matters, because it is what says "this field is still
    // empty" about text that otherwise looks typed. Someone completed the form, believed the
    // endpoint was set, and met a disabled button saying "needs an endpoint".
    const { field } = setup();
    expect(screen.getByText(/→ or Tab to use it/)).toBeInTheDocument();

    // And it goes away the moment the suggestion is taken, so it doubles as feedback.
    await userEvent.click(field);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText(/to use it/)).not.toBeInTheDocument();
  });

  it("dims the suggestion so it cannot pass for a value", () => {
    // The other half of the same fix: the default placeholder colour is as dark as plenty of
    // real text, and in a mono face `http://127.0.0.1:9000` read as filled in.
    const { field } = setup();
    expect(field.className).toContain("placeholder:text-muted-foreground/50");

    document.body.replaceChildren();
    const plain = setup({ suggestion: undefined, placeholder: "minio (dev)" });
    expect(plain.field.className).not.toContain("placeholder:text-muted-foreground/50");
  });

  it("hides the hint once a value is typed", async () => {
    const { field } = setup({ value: "http://mine" });
    expect(screen.queryByText(/to use it/)).not.toBeInTheDocument();
    expect(field).toHaveValue("http://mine");
  });

  it("uses the suggestion as the placeholder, so the two cannot disagree", () => {
    const { field } = setup();
    expect(field).toHaveAttribute("placeholder", "http://127.0.0.1:9000");
  });
});
