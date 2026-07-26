import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DatasetEditor } from "@/components/DatasetEditor";
import { addRow, emptyDataset, setRowBody, setRowCheck, setRowName } from "@/lib/dataset";
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

    await userEvent.type(screen.getByLabelText(/^body for valid$/i), "!");
    expect(onChange.mock.calls.at(-1)![0].rows[0].body).toBe('{"email":"a@b.com"}!');

    onChange.mockClear();
    await userEvent.clear(screen.getByLabelText(/expected result for valid/i));
    expect(onChange.mock.calls.at(-1)![0].rows[0].check).toBe("");
  });

  it("keeps the body one row tall until it is focused", async () => {
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);
    const body = screen.getByLabelText(/^body for valid$/i);

    // Collapsed: single-row height, no wrapping.
    expect(body.className).toContain("h-9");
    expect(body.className).toContain("whitespace-nowrap");

    await userEvent.click(body);
    expect(body.className).toContain("h-[132px]");
    expect(body.className).not.toContain("whitespace-nowrap");
  });

  it("warns about broken JSON without blocking it", async () => {
    let d = seed();
    d = setRowBody(d, d.rows[0].id, '{"a":1');
    render(<DatasetEditor dataset={d} onChange={vi.fn()} />);
    const body = screen.getByLabelText(/^body for valid$/i);

    // Collapsed, the cue is the border — the text would defeat the single-row height.
    expect(body.className).toContain("border-warning");
    expect(screen.queryByText(/not valid json/i)).not.toBeInTheDocument();

    await userEvent.click(body);
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

  it("duplicates a case", async () => {
    const onChange = vi.fn();
    render(<DatasetEditor dataset={seed()} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /duplicate valid/i }));
    expect(onChange.mock.calls[0][0].rows).toHaveLength(2);
  });
});
