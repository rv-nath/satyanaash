import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DatasetEditor } from "@/components/DatasetEditor";
import { addRow, emptyDataset, setRowBody, setRowCheck, setRowName, setRowNeedsFlow, setRowVar } from "@/lib/dataset";
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
