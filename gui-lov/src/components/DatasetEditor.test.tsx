import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/** The editor keeps the open case in `?row=`, so it needs a router. Wrapped here rather than in
 *  every test, and named `render` so the existing tests read unchanged.
 *
 *  `rerender` is wrapped too: the bare one re-renders without the router, which fails inside the
 *  component rather than in the test, so the message names React Router instead of the setup. */
const render = (ui: React.ReactElement, initial = "/") => {
  const wrap = (node: React.ReactElement) => (
    <MemoryRouter initialEntries={[initial]}>{node}</MemoryRouter>
  );
  const result = rtlRender(wrap(ui));
  return { ...result, rerender: (node: React.ReactElement) => result.rerender(wrap(node)) };
};
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

describe("DatasetEditor request parameters", () => {
  const endpoint =
    "{{baseUrl}}/api/v1/campaigns/{{channel}}/pause/{{campaignID}}/{{recurrenceID}}";

  const headings = () =>
    screen
      .getAllByText(/^(Case|Parameters|Path \/ query|Body|Expect)$/)
      .filter((el) => el.tagName === "SPAN")
      .map((el) => el.textContent);

  it("gives every declared name one column, named for what it is and not for the request", () => {
    // The point of the change. It used to grow a column per placeholder — headed `channel`, or
    // on another project `bad_auth` — so the table's shape was a function of the request's
    // content. One fixed heading whatever the request declares.
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} endpoint={endpoint} />);

    expect(headings()).toEqual(["Case", "Parameters", "Path / query", "Body", "Expect"]);
    expect(screen.queryByText("channel")).not.toBeInTheDocument();
    expect(screen.queryByText("campaignID")).not.toBeInTheDocument();
    expect(screen.queryByText("baseUrl")).not.toBeInTheDocument();
  });

  it("names the declared names on the heading, since the heading no longer does", () => {
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} endpoint={endpoint} />);
    const title = screen.getByText("Parameters").getAttribute("title") ?? "";
    for (const name of ["{{channel}}", "{{campaignID}}", "{{recurrenceID}}"]) {
      expect(title).toContain(name);
    }
    // baseUrl is the prefix, not a parameter.
    expect(title).not.toContain("baseUrl");
  });

  it("leaves a dataset alone when the request declares no parameters", () => {
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} endpoint="{{baseUrl}}/signup" />);
    // Absent, not present and empty.
    expect(headings()).toEqual(["Case", "Path / query", "Body", "Expect"]);
    expect(screen.getByLabelText(/case name for row 1/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/parameters for/i)).not.toBeInTheDocument();
  });

  it("previews one declared name as its bare value, so the column still scans", () => {
    let d = seed();
    d = setRowVar(d, d.rows[0].id, "channel", "sms");
    render(
      <DatasetEditor dataset={d} onChange={vi.fn()} endpoint="{{baseUrl}}/campaigns/{{channel}}" />,
    );
    expect(screen.getByLabelText(/parameters for valid/i)).toHaveTextContent("sms");
  });

  it("previews several as name=value, because a bare value could not say which name it filled", () => {
    let d = seed();
    d = setRowVar(d, d.rows[0].id, "campaignID", "c-456");
    render(<DatasetEditor dataset={d} onChange={vi.fn()} endpoint={endpoint} />);
    expect(screen.getByLabelText(/parameters for valid/i)).toHaveTextContent("campaignID=c-456");
  });

  it("says what an empty cell means rather than showing an example", () => {
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} endpoint={endpoint} />);
    expect(screen.getByLabelText(/parameters for valid/i)).toHaveTextContent(/sets none of them/i);
  });

  it("offers the column as soon as the URL mentions a name, before saving", () => {
    // The editor passes the endpoint being edited, not the saved one.
    const { rerender } = render(
      <DatasetEditor dataset={seed()} onChange={vi.fn()} endpoint="{{baseUrl}}/campaigns" />,
    );
    expect(screen.queryByText("Parameters")).not.toBeInTheDocument();

    rerender(
      <DatasetEditor dataset={seed()} onChange={vi.fn()} endpoint="{{baseUrl}}/campaigns/{{channel}}" />,
    );
    expect(screen.getByText("Parameters")).toBeInTheDocument();
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



describe("DatasetEditor — the row's actions", () => {
  it("keeps all three out of the way until the row is hovered or focused", () => {
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);
    for (const name of [/^edit valid$/i, /^duplicate valid$/i, /^remove valid$/i]) {
      expect(screen.getByRole("button", { name })).toHaveClass("opacity-0");
    }
  });

  it("reveals them by opacity and never by width, so nothing shifts on hover", () => {
    // A gutter that appears on hover and reflows the row would move every value sideways as the
    // pointer travels down twenty rows — the fault this codebase already guards against for
    // canvas nodes.
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);
    const edit = screen.getByRole("button", { name: /^edit valid$/i });
    expect(edit.className).toContain("group-hover:opacity-100");
    expect(edit.className).toContain("w-full");
    expect(edit.className).not.toMatch(/\bhidden\b|group-hover:block|group-hover:w-/);
  });

  it("stays reachable without a mouse", () => {
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);
    const edit = screen.getByRole("button", { name: /^edit valid$/i });
    expect(edit.className).toContain("focus-visible:opacity-100");
  });
});

describe("DatasetEditor — a case on its own page", () => {
  const endpoint = "{{baseUrl}}/api/v1/accounts/list";
  const requestHeaders = [
    { id: "h1", key: "Authorization", value: "Bearer {{token}}", enabled: true },
    { id: "h2", key: "Content-Type", value: "application/json", enabled: true },
  ];

  const openCase = async (dataset = seed()) => {
    const onChange = vi.fn();
    render(
      <DatasetEditor
        dataset={dataset}
        onChange={onChange}
        endpoint={endpoint}
        headers={requestHeaders}
        method="GET"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^edit valid$/i }));
    return onChange;
  };

  it("replaces the matrix rather than floating over it", async () => {
    // It was a dialog first and outgrew it: max-h-[60vh] was clipping the body with five sections,
    // and headers needs several times that.
    await openCase();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /all 1 case/i })).toBeInTheDocument();
    // The table is gone, not merely scrolled away.
    expect(screen.queryByLabelText(/^body for valid$/i)).not.toBeInTheDocument();
  });

  it("shows the request it varies, and does not offer it as a field", async () => {
    await openCase();
    expect(screen.getByText(/GET \{\{baseUrl\}\}\/api\/v1\/accounts\/list/)).toBeInTheDocument();
    // A case cannot change either, and a box would say it can.
    expect(screen.queryByLabelText(/^endpoint$/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^method$/i)).not.toBeInTheDocument();
  });

  it("lists the request's headers as inherited, so the page says what the case sends", async () => {
    await openCase();
    expect(screen.getByText("Authorization")).toBeInTheDocument();
    expect(screen.getByText("Content-Type")).toBeInTheDocument();
    expect(screen.getAllByText(/from the request/i).length).toBeGreaterThan(0);
  });

  it("overrides one header on this case alone", async () => {
    const onChange = await openCase();
    await userEvent.click(screen.getByRole("button", { name: /override Authorization/i }));
    const last = onChange.mock.calls.at(-1)![0] as Dataset;
    expect(last.rows[0].headers?.[0]).toMatchObject({ key: "Authorization", enabled: true });
  });

  it("unticking a header is how a case says 'send no such header'", async () => {
    // The case that forced a duplicate test case to exist, because it was otherwise unsayable.
    const onChange = await openCase();
    await userEvent.click(screen.getByRole("checkbox", { name: /send Authorization/i }));
    const last = onChange.mock.calls.at(-1)![0] as Dataset;
    expect(last.rows[0].headers?.[0]).toMatchObject({ key: "Authorization", enabled: false });
  });

  it("writes edits straight through, with no draft to save", async () => {
    // A page is where you are, not a detour, so there is no Cancel and no Save — the test case's
    // own dirty-and-save owns the result.
    const onChange = await openCase();
    expect(screen.queryByRole("button", { name: /^save$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^cancel$/i })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/^case name$/i), "!");
    expect(onChange).toHaveBeenCalled();
  });

  it("keeps the open case in the URL, so Back leaves it and a link can be pasted", async () => {
    let d = addRow(seed());
    d = setRowName(d, d.rows[1].id, "second");
    render(
      <DatasetEditor dataset={d} onChange={vi.fn()} endpoint={endpoint} headers={requestHeaders} />,
      `/?row=${d.rows[1].id}`,
    );
    // Opened straight from the URL, without a click.
    expect(screen.getByRole("heading", { name: "second" })).toBeInTheDocument();
  });

  it("walks the dataset case by case, which is what the matrix cannot do from here", async () => {
    let d = addRow(seed());
    d = setRowName(d, d.rows[1].id, "second");
    render(
      <DatasetEditor dataset={d} onChange={vi.fn()} endpoint={endpoint} headers={requestHeaders} />,
      `/?row=${d.rows[0].id}`,
    );
    expect(screen.getByText(/case 1 of 2/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /previous case/i })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /next case/i }));
    expect(screen.getByRole("heading", { name: "second" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next case/i })).toBeDisabled();
  });

  it("has no parameters section when the endpoint declares nothing", async () => {
    const onChange = vi.fn();
    render(<DatasetEditor dataset={seed()} onChange={onChange} endpoint="{{baseUrl}}/signup" />);
    await userEvent.click(screen.getByRole("button", { name: /^edit valid$/i }));
    // Absent rather than an empty section, which reads as something failing to load.
    expect(screen.queryByText("Parameters")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^body$/i)).toBeInTheDocument();
  });

  it("states where a case runs as one choice of three, not two switches", async () => {
    await openCase();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });
});
