import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DatasetEditor } from "@/components/DatasetEditor";
import { addRow, emptyDataset, setRowBody, setRowCheck, setRowName, setRowNeedsFlow } from "@/lib/dataset";
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

  it("keeps every row one line tall until one is opened", async () => {
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);

    // Collapsed: a clipped one-line preview, not an editable field.
    const collapsed = screen.getByLabelText(/^body for valid$/i);
    expect(collapsed.tagName).toBe("BUTTON");
    expect(collapsed.className).toContain("truncate");

    await userEvent.click(collapsed);
    const editor = screen.getByLabelText(/^body for valid$/i);
    expect(editor.tagName).toBe("TEXTAREA");
    // Across the table rather than inside a 180px column, which is the whole point:
    // a JSON payload in a table cell is miserable clipped or not.
    expect(editor.className).toContain("w-full");
    expect(editor.className).toContain("h-[200px]");
  });

  it("opens the row with the field you clicked already focused", async () => {
    // Otherwise the roomier editor would cost a click that the cramped one didn't.
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);

    await userEvent.click(screen.getByLabelText(/^body for valid$/i));
    expect(screen.getByLabelText(/^body for valid$/i)).toHaveFocus();
  });

  it("focuses the case name when that is what was clicked", async () => {
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);
    await userEvent.click(screen.getByLabelText(/case name for row 1/i));
    expect(screen.getByLabelText(/case name for row 1/i)).toHaveFocus();
  });

  it("shows the whole value as a tooltip on a cell that had to clip it", () => {
    // The Case column was a plain input: no ellipsis, no tooltip, so a long name was
    // simply cut with nothing to say more existed.
    const long = "missing 'msg' for a promo campaign with a long name";
    let d = seed();
    d = setRowName(d, d.rows[0].id, long);
    render(<DatasetEditor dataset={d} onChange={vi.fn()} />);
    expect(screen.getByLabelText(/case name for row 1/i)).toHaveAttribute("title", long);
  });

  it("closes on Escape but not on tabbing between its own fields", async () => {
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);
    await userEvent.click(screen.getByLabelText(/^body for valid$/i));
    expect(screen.getByLabelText(/^body for valid$/i).tagName).toBe("TEXTAREA");

    // Moving between Case, Path, Body and Expect must not collapse the panel.
    await userEvent.tab();
    expect(screen.getByLabelText(/^body for valid$/i).tagName).toBe("TEXTAREA");

    await userEvent.keyboard("{Escape}");
    expect(screen.getByLabelText(/^body for valid$/i).tagName).toBe("BUTTON");
  });

  it("collapses from the chevron too", async () => {
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);
    await userEvent.click(screen.getByLabelText(/^body for valid$/i));
    await userEvent.click(screen.getByRole("button", { name: /collapse valid/i }));
    expect(screen.getByLabelText(/^body for valid$/i).tagName).toBe("BUTTON");
  });

  it("opens one row at a time, so the matrix stays a matrix", async () => {
    const d = addRow(seed());
    render(<DatasetEditor dataset={d} onChange={vi.fn()} />);

    await userEvent.click(screen.getByLabelText(/^body for valid$/i));
    expect(screen.getByLabelText(/^body for valid$/i).tagName).toBe("TEXTAREA");

    await userEvent.click(screen.getByLabelText(/^body for row 2$/i));
    expect(screen.getByLabelText(/^body for row 2$/i).tagName).toBe("TEXTAREA");
    expect(screen.getByLabelText(/^body for valid$/i).tagName).toBe("BUTTON");
  });

  it("keeps the row's own actions reachable while it is open", async () => {
    const onChange = vi.fn();
    render(<DatasetEditor dataset={seed()} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText(/^body for valid$/i));

    // Collapsing a row just to flag, copy or bin it would be daft.
    await userEvent.click(screen.getByRole("button", { name: /don't run valid from run dataset/i }));
    expect(onChange.mock.calls.at(-1)![0].rows[0].needs_flow).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: /duplicate valid/i }));
    expect(onChange.mock.calls.at(-1)![0].rows).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: /remove valid/i }));
    expect(onChange.mock.calls.at(-1)![0].rows).toHaveLength(0);
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
