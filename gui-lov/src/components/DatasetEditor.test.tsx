import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DatasetEditor } from "@/components/DatasetEditor";
import { addRow, emptyDataset, setRowBody, setRowCheck, setRowName, setRowDisabled, setRowNeedsFlow, setRowVar } from "@/lib/dataset";
import type { Dataset } from "@/lib/api/types";

function seed(): Dataset {
  let d = addRow(emptyDataset());
  d = setRowName(d, d.rows[0].id, "valid");
  d = setRowBody(d, d.rows[0].id, '{"email":"a@b.com"}');
  d = setRowCheck(d, d.rows[0].id, "201");
  return d;
}

describe("DatasetEditor", () => {
  it("shows a worked example when empty", () => {
    render(<DatasetEditor dataset={emptyDataset()} onChange={vi.fn()} />);
    expect(screen.getByText(/no cases yet/i)).toBeInTheDocument();
    expect(screen.getByText(/a body plus the status you expect/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add the first case/i })).toBeInTheDocument();
  });

  it("adds a case", async () => {
    const onChange = vi.fn();
    render(<DatasetEditor dataset={emptyDataset()} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /add the first case/i }));
    expect(onChange.mock.calls[0][0].rows).toHaveLength(1);
  });

  it("an empty cell says what is true, never an example of what could go in it", async () => {
    // The fault: these cells are `border-0 bg-transparent`, invisible until focused, so the
    // editing example sat in a blank cell looking like content. Truncated to the column
    // width it read as `{"email": "a@b.com"}` — a body the row does not have — and the only
    // way to find out was to click in and start typing.
    let d = addRow(emptyDataset());
    d = setRowName(d, d.rows[0].id, "empties");
    render(<DatasetEditor dataset={d} onChange={vi.fn()} />);

    const body = screen.getByLabelText(/^body for empties$/i);
    expect(body).toHaveTextContent("uses the request’s body");
    // Nothing JSON-shaped, and not in the mono face the real values wear.
    expect(body.textContent).not.toContain("{");
    expect(body.className).toContain("italic");
    expect(body.className).not.toContain("font-mono");

    // Blank Expect is not an absence of a rule — the engine requires a 2xx — and these are
    // the words the result reports back as what was expected.
    expect(screen.getByLabelText(/^expected result for empties$/i)).toHaveTextContent("any 2xx");
  });

  it("keeps the example, but only once you are typing in the field", async () => {
    // An example is genuinely useful — the objection was to showing it where it could pass
    // for a value. In an open editor the field is visibly a field.
    let d = addRow(emptyDataset());
    d = setRowName(d, d.rows[0].id, "empties");
    render(<DatasetEditor dataset={d} onChange={vi.fn()} />);

    await userEvent.click(screen.getByLabelText(/^body for empties$/i));
    expect(screen.getByLabelText(/^body for empties$/i)).toHaveAttribute(
      "placeholder",
      expect.stringContaining('{"email": "a@b.com"}'),
    );
  });

  it("a real value still looks like a value", async () => {
    // The empty-state styling must not leak onto content — a body that is there wears the
    // mono face and full-strength ink.
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);
    const body = screen.getByLabelText(/^body for valid$/i);
    expect(body).toHaveTextContent('{"email":"a@b.com"}');
    expect(body.className).toContain("font-mono");
    expect(body.className).not.toContain("italic");
  });

  it("reports body and check edits", async () => {
    const onChange = vi.fn();
    const d = seed();
    render(<DatasetEditor dataset={d} onChange={onChange} />);

    // A cell opens on click, then edits like any field.
    await userEvent.click(screen.getByLabelText(/^body for valid$/i));
    await userEvent.type(screen.getByLabelText(/^body for valid$/i), "!");
    expect(onChange.mock.calls.at(-1)![0].rows[0].body).toBe('{"email":"a@b.com"}!');

    onChange.mockClear();
    await userEvent.click(screen.getByLabelText(/expected result for valid/i));
    await userEvent.clear(screen.getByLabelText(/expected result for valid/i));
    expect(onChange.mock.calls.at(-1)![0].rows[0].check).toBe("");
  });

  it("keeps a body to one line until you are in it", async () => {
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);

    // Collapsed: a clipped one-line preview, not an editable field.
    const collapsed = screen.getByLabelText(/^body for valid$/i);
    expect(collapsed.tagName).toBe("BUTTON");
    expect(collapsed.className).toContain("truncate");

    await userEvent.click(collapsed);
    const editor = screen.getByLabelText(/^body for valid$/i);
    expect(editor.tagName).toBe("TEXTAREA");
    // Grows into something you can actually read a payload in.
    expect(editor.className).toContain("h-[220px]");
  });

  it("gives the case name a roomy field too, wrapping rather than scrolling sideways", async () => {
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);
    await userEvent.click(screen.getByLabelText(/case name for row 1/i));
    const editor = screen.getByLabelText(/case name for row 1/i);
    expect(editor.tagName).toBe("TEXTAREA");
    expect(editor.className).toContain("h-[72px]");
    // Prose wraps; a body keeps its authored line breaks instead.
    expect(editor.className).toContain("whitespace-normal");
  });

  it("puts the caret in the cell you clicked", async () => {
    // Otherwise the roomier editor would cost a click the cramped one didn't.
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);

    await userEvent.click(screen.getByLabelText(/^body for valid$/i));
    expect(screen.getByLabelText(/^body for valid$/i)).toHaveFocus();
  });

  it("focuses the case name when that is what was clicked", async () => {
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);
    await userEvent.click(screen.getByLabelText(/case name for row 1/i));
    expect(screen.getByLabelText(/case name for row 1/i)).toHaveFocus();
  });

  it("shows a long case name in full, wrapped — it is what identifies the row", () => {
    // The complaint this exists for: the name is the important bit, and a name you have
    // to hover to finish is not readable. It was a plain input before, so it clipped
    // with no ellipsis and no tooltip either.
    const long = "missing 'msg' for a promo campaign with a long name";
    let d = seed();
    d = setRowName(d, d.rows[0].id, long);
    render(<DatasetEditor dataset={d} onChange={vi.fn()} />);

    const cell = screen.getByLabelText(/case name for row 1/i);
    expect(cell).toHaveTextContent(long);
    expect(cell.className).not.toContain("truncate");
    expect(cell.className).toContain("break-words");
    // Nothing is hidden, so a tooltip would only repeat what is on screen.
    expect(cell).not.toHaveAttribute("title");
  });

  it("keeps a body to one line — a payload is reference, not identity", () => {
    // Wrapping a fifteen-line body in a table cell would bury the names it sits beside.
    let d = seed();
    d = setRowBody(d, d.rows[0].id, `{"a":"${"x".repeat(300)}"}`);
    render(<DatasetEditor dataset={d} onChange={vi.fn()} />);

    const cell = screen.getByLabelText(/^body for valid$/i);
    expect(cell.className).toContain("truncate");
    // Clipped, so this one does need the tooltip.
    expect(cell).toHaveAttribute("title", expect.stringContaining("xxx"));
  });

  it("collapses the cell when focus leaves it", async () => {
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);
    await userEvent.click(screen.getByLabelText(/^body for valid$/i));
    expect(screen.getByLabelText(/^body for valid$/i).tagName).toBe("TEXTAREA");

    await userEvent.tab();
    expect(screen.getByLabelText(/^body for valid$/i).tagName).toBe("BUTTON");
  });

  it("expands one cell at a time, so the matrix stays a matrix", async () => {
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);

    await userEvent.click(screen.getByLabelText(/^body for valid$/i));
    expect(screen.getByLabelText(/^body for valid$/i).tagName).toBe("TEXTAREA");

    await userEvent.click(screen.getByLabelText(/expected result for valid/i));
    expect(screen.getByLabelText(/expected result for valid/i).tagName).toBe("TEXTAREA");
    expect(screen.getByLabelText(/^body for valid$/i).tagName).toBe("BUTTON");
  });

  it("shows a minified body so the preview isn't a lone brace", async () => {
    let d = seed();
    d = setRowBody(d, d.rows[0].id, '{\n  "email": "a@b.com",\n  "mobile": "918"\n}');
    render(<DatasetEditor dataset={d} onChange={vi.fn()} />);

    const collapsed = screen.getByLabelText(/^body for valid$/i);
    expect(collapsed).toHaveTextContent('{"email":"a@b.com","mobile":"918"}');

    // Editing shows the body exactly as it was authored — the preview never rewrites it.
    await userEvent.click(collapsed);
    expect(screen.getByLabelText(/^body for valid$/i)).toHaveValue(
      '{\n  "email": "a@b.com",\n  "mobile": "918"\n}',
    );
  });

  it("warns about broken JSON without blocking it", async () => {
    let d = seed();
    d = setRowBody(d, d.rows[0].id, '{"a":1');
    render(<DatasetEditor dataset={d} onChange={vi.fn()} />);
    const collapsed = screen.getByLabelText(/^body for valid$/i);

    // Collapsed, the cue is the colour — a message would defeat the single-row height.
    expect(collapsed.className).toContain("text-warning");
    expect(screen.queryByText(/not valid json/i)).not.toBeInTheDocument();

    await userEvent.click(collapsed);
    expect(screen.getByText(/not valid json/i)).toBeInTheDocument();
  });

  it("says a blank check means any 2xx", async () => {
    let d = seed();
    d = setRowCheck(d, d.rows[0].id, "");
    render(<DatasetEditor dataset={d} onChange={vi.fn()} />);

    await userEvent.click(screen.getByLabelText(/expected result for valid/i));
    expect(screen.getByText(/passes on any 2xx/i)).toBeInTheDocument();
  });

  it("explains a status shorthand and an expression differently", async () => {
    const d = seed(); // check is "201"
    const { rerender } = render(<DatasetEditor dataset={d} onChange={vi.fn()} />);

    await userEvent.click(screen.getByLabelText(/expected result for valid/i));
    expect(screen.getByText(/shorthand for response.status == 201/i)).toBeInTheDocument();

    const expr = setRowCheck(d, d.rows[0].id, "response.json.token != ()");
    rerender(<DatasetEditor dataset={expr} onChange={vi.fn()} />);
    await userEvent.click(screen.getByLabelText(/expected result for valid/i));
    expect(screen.getByText(/rhai expression/i)).toBeInTheDocument();
  });

  it("marks a row as needing a flow, and back", async () => {
    const onChange = vi.fn();
    const d = seed();
    const { rerender } = render(<DatasetEditor dataset={d} onChange={onChange} />);

    await userEvent.click(screen.getByRole("button", { name: /don't run valid from run dataset/i }));
    expect(onChange.mock.calls[0][0].rows[0].needs_flow).toBe(true);

    onChange.mockClear();
    rerender(<DatasetEditor dataset={setRowNeedsFlow(d, d.rows[0].id, true)} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /^run valid from run dataset$/i }));
    expect(onChange.mock.calls[0][0].rows[0].needs_flow).toBe(false);
  });

  it("shows a marked row as blocked and stepped back", async () => {
    const d = seed();
    const marked = setRowNeedsFlow(d, d.rows[0].id, true);
    const { rerender } = render(<DatasetEditor dataset={marked} onChange={vi.fn()} />);

    // Red on the marker: this row is blocked here, not merely different.
    const flag = screen.getByRole("button", { name: /^run valid from run dataset$/i });
    expect(flag.className).toContain("text-destructive");

    // And its fields step back, because they take no part in a Run dataset.
    expect(screen.getByLabelText(/^body for valid$/i).parentElement!.className).toContain(
      "opacity-50",
    );

    // Editing is still full strength — you can't read what you're typing through a fade.
    await userEvent.click(screen.getByLabelText(/^body for valid$/i));
    expect(screen.getByLabelText(/^body for valid$/i).parentElement!.className).not.toContain(
      "opacity-50",
    );

    // An unmarked row is untouched.
    rerender(<DatasetEditor dataset={d} onChange={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: /don't run valid from run dataset/i }).className,
    ).not.toContain("text-destructive");
  });

  it("duplicates a case", async () => {
    const onChange = vi.fn();
    render(<DatasetEditor dataset={seed()} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /duplicate valid/i }));
    expect(onChange.mock.calls[0][0].rows).toHaveLength(2);
  });
});

describe("DatasetEditor endpoint parameters", () => {
  const endpoint =
    "{{baseUrl}}/api/v1/campaigns/{{channel}}/pause/{{campaignID}}/{{recurrenceID}}";

  it("grows a column per placeholder the endpoint declares", () => {
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} endpoint={endpoint} />);

    // Named as written in the URL, so the column and the placeholder are obviously
    // the same thing. baseUrl is the prefix, not a parameter.
    expect(screen.getByText("channel")).toBeInTheDocument();
    expect(screen.getByText("campaignID")).toBeInTheDocument();
    expect(screen.getByText("recurrenceID")).toBeInTheDocument();
    expect(screen.queryByText("baseUrl")).not.toBeInTheDocument();

    // And the columns that were always there are still there, with the parameters
    // sitting between Case and them.
    // Spans only: the footer's help text mentions "Path / query" in a <strong>.
    const headings = screen
      .getAllByText(/^(Case|channel|campaignID|recurrenceID|Path \/ query|Body|Expect)$/)
      .filter((el) => el.tagName === "SPAN")
      .map((el) => el.textContent);
    expect(headings).toEqual([
      "Case", "channel", "campaignID", "recurrenceID", "Path / query", "Body", "Expect",
    ]);
  });

  it("leaves a dataset alone when the endpoint has no parameters", () => {
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} endpoint="{{baseUrl}}/signup" />);
    expect(screen.getByText("Case")).toBeInTheDocument();
    expect(screen.getByText("Body")).toBeInTheDocument();
    // Nothing extra: a signup case looks exactly as it did.
    expect(screen.getByLabelText(/case name for row 1/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/channel for valid/i)).not.toBeInTheDocument();
  });

  it("records a value against the row and the name", async () => {
    const onChange = vi.fn();
    render(<DatasetEditor dataset={seed()} onChange={onChange} endpoint={endpoint} />);

    await userEvent.type(screen.getByLabelText(/^channel for valid$/i), "sms");
    expect(onChange.mock.calls.at(-1)![0].rows[0].vars).toEqual({ channel: "s" });
  });

  it("shows what a row already has for each parameter", () => {
    let d = seed();
    d = setRowVar(d, d.rows[0].id, "channel", "email");
    d = setRowVar(d, d.rows[0].id, "campaignID", "c-456");
    render(<DatasetEditor dataset={d} onChange={vi.fn()} endpoint={endpoint} />);

    expect(screen.getByLabelText(/^channel for valid$/i)).toHaveValue("email");
    expect(screen.getByLabelText(/^campaignid for valid$/i)).toHaveValue("c-456");
    // Unset stays empty rather than inventing something.
    expect(screen.getByLabelText(/^recurrenceid for valid$/i)).toHaveValue("");
  });

  it("offers the column as soon as the URL mentions it, before saving", () => {
    // The editor passes the endpoint being edited, not the saved one.
    const { rerender } = render(
      <DatasetEditor dataset={seed()} onChange={vi.fn()} endpoint="{{baseUrl}}/campaigns" />,
    );
    expect(screen.queryByText("channel")).not.toBeInTheDocument();

    rerender(
      <DatasetEditor dataset={seed()} onChange={vi.fn()} endpoint="{{baseUrl}}/campaigns/{{channel}}" />,
    );
    expect(screen.getByText("channel")).toBeInTheDocument();
  });
});

describe("DatasetEditor parking a row", () => {
  it("draws nothing for a row that runs — running is the norm, not news", () => {
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);
    // The control is there to be found, but ghosted: no tick, no badge, nothing
    // decorating an ordinary row.
    const control = screen.getByRole("button", { name: /disable valid/i });
    expect(control.className).toContain("text-muted-foreground/25");
    expect(control).toHaveAttribute("aria-pressed", "false");
  });

  it("marks only the exception", () => {
    const d = seed();
    render(<DatasetEditor dataset={setRowDisabled(d, d.rows[0].id, true)} onChange={vi.fn()} />);
    const control = screen.getByRole("button", { name: /enable valid/i });
    // Amber rather than the ⛓'s red: parking is a choice, not a blockade.
    expect(control.className).toContain("text-warning");
    expect(control).toHaveAttribute("aria-pressed", "true");
  });

  it("parks a row, and brings it back", async () => {
    const onChange = vi.fn();
    const d = seed();
    const { rerender } = render(<DatasetEditor dataset={d} onChange={onChange} />);

    await userEvent.click(screen.getByRole("button", { name: /disable valid/i }));
    expect(onChange.mock.calls[0][0].rows[0].disabled).toBe(true);

    onChange.mockClear();
    rerender(
      <DatasetEditor dataset={setRowDisabled(d, d.rows[0].id, true)} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /enable valid/i }));
    expect(onChange.mock.calls[0][0].rows[0].disabled).toBe(false);
  });

  it("steps a parked row back, as it does one that needs a flow", () => {
    let d = seed();
    d = setRowDisabled(d, d.rows[0].id, true);
    render(<DatasetEditor dataset={d} onChange={vi.fn()} />);
    expect(screen.getByLabelText(/^body for valid$/i).parentElement!.className).toContain(
      "opacity-50",
    );
  });

  it("rules through the name, but never the payload", () => {
    // A line through monospace JSON collides with the braces and quotes, and the payload
    // is the thing you come back to finish.
    let d = seed();
    d = setRowDisabled(d, d.rows[0].id, true);
    render(<DatasetEditor dataset={d} onChange={vi.fn()} />);

    expect(screen.getByLabelText(/case name for row 1/i).className).toContain("line-through");
    expect(screen.getByLabelText(/^body for valid$/i).className).not.toContain("line-through");
  });

  it("doesn't rule through what you're typing", async () => {
    let d = seed();
    d = setRowDisabled(d, d.rows[0].id, true);
    render(<DatasetEditor dataset={d} onChange={vi.fn()} />);

    await userEvent.click(screen.getByLabelText(/case name for row 1/i));
    const editor = screen.getByLabelText(/case name for row 1/i);
    expect(editor.tagName).toBe("TEXTAREA");
    expect(editor.className).not.toContain("line-through");
  });

  it("leaves a running row's name alone", () => {
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);
    expect(screen.getByLabelText(/case name for row 1/i).className).not.toContain("line-through");
  });

  it("says what it does, so it doesn't read as delete", () => {
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /disable valid/i })).toHaveAttribute(
      "title",
      expect.stringMatching(/park this row while you draft/i),
    );
  });
});

describe("DatasetEditor room to write", () => {
  it("offers a larger editor for the cells that hold code, and not for the rest", async () => {
    // Expect is a `minmax(90px,0.4fr)` column, so expanding in place leaves a Rhai expression
    // in ninety pixels. Case and the path parameters hold a word — an icon in every cell of
    // twenty-one rows is the clutter this table was cleaned up to remove.
    const { rerender } = render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: /expected result for/i }));
    expect(screen.getByRole("button", { name: /room to write/i })).toBeInTheDocument();

    rerender(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /^case name for/i }));
    expect(screen.queryByRole("button", { name: /room to write/i })).not.toBeInTheDocument();
  });

  it("commits only on Save, and leaves the cell alone on Cancel", async () => {
    // Escape means abandon everywhere else in this app; live-editing would have made it mean
    // keep. A modal that cannot be backed out of is not a modal.
    const onChange = vi.fn();
    render(<DatasetEditor dataset={seed()} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /expected result for/i }));
    await userEvent.click(screen.getByRole("button", { name: /room to write/i }));

    const big = within(screen.getByRole("dialog")).getByRole("textbox");
    await userEvent.clear(big);
    await userEvent.type(big, "response.status == 202");
    // Nothing has reached the dataset yet.
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onChange).not.toHaveBeenCalled();

    // Same again, this time saving.
    await userEvent.click(screen.getByRole("button", { name: /expected result for/i }));
    await userEvent.click(screen.getByRole("button", { name: /room to write/i }));
    const again = within(screen.getByRole("dialog")).getByRole("textbox");
    await userEvent.clear(again);
    await userEvent.type(again, "response.status == 202");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    const rows = onChange.mock.calls.at(-1)![0].rows;
    expect(rows[0].check).toBe("response.status == 202");
  });

  it("cannot save what hasn't changed, and says so", async () => {
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /expected result for/i }));
    await userEvent.click(screen.getByRole("button", { name: /room to write/i }));
    expect(screen.getByText(/no changes/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
  });

  it("opens on the cell's current value, not the last thing typed in the dialog", async () => {
    // The snapshot is taken on open. Cancel, edit the cell, reopen — the dialog must not still
    // be holding the abandoned draft.
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /expected result for/i }));
    await userEvent.click(screen.getByRole("button", { name: /room to write/i }));
    await userEvent.type(within(screen.getByRole("dialog")).getByRole("textbox"), "999");
    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await userEvent.click(screen.getByRole("button", { name: /expected result for/i }));
    await userEvent.click(screen.getByRole("button", { name: /room to write/i }));
    expect(within(screen.getByRole("dialog")).getByRole("textbox")).toHaveValue("201");
  });

  it("marks itself as a modal layer, which is what stops Escape closing the editor", async () => {
    // The bug this pins: `TestCaseEditor` has a *document-level* Escape listener that closes the
    // whole editor, so dismissing this dialog landed you on the welcome page. The guard there
    // keys off exactly this attribute pair, and Radix — not our code — sets them.
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /expected result for/i }));
    await userEvent.click(screen.getByRole("button", { name: /room to write/i }));
    expect(document.querySelector('[role="dialog"][data-state="open"]')).not.toBeNull();
  });

  it("keeps the cell open while the dialog is, and edits its own copy", async () => {
    // The dialog taking focus is a blur on the cell behind it. Collapsing on that blur would
    // unmount the dialog in the same tick it opened.
    const onChange = vi.fn();
    render(<DatasetEditor dataset={seed()} onChange={onChange} />);

    await userEvent.click(screen.getByRole("button", { name: /expected result for/i }));
    await userEvent.click(screen.getByRole("button", { name: /room to write/i }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    const big = within(dialog).getByRole("textbox");
    expect(big).toHaveValue("201");
    // Its own copy: nothing reaches the dataset until Save.
    await userEvent.type(big, "x");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("says which of the two versions survives", async () => {
    // A modal over a live table has to be clear about that, or Save and Escape are a coin toss.
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /expected result for/i }));
    await userEvent.click(screen.getByRole("button", { name: /room to write/i }));
    expect(screen.getByText(/leaves the cell as it was/i)).toBeInTheDocument();
  });
});
