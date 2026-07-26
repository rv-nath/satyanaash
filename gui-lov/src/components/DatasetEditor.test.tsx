import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DatasetEditor } from "@/components/DatasetEditor";
import { addColumn, addRow, emptyDataset, setCell } from "@/lib/dataset";
import type { Dataset } from "@/lib/api/types";

function seed(): Dataset {
  let d = emptyDataset();
  d = addColumn(d, "email");
  d = addRow(d);
  d = setCell(d, d.rows[0].id, "email", "a@x.com");
  return d;
}

describe("DatasetEditor", () => {
  it("teaches the column/row model when empty", () => {
    // An empty grid should explain the model, not just say "empty".
    render(<DatasetEditor dataset={emptyDataset()} onChange={vi.fn()} />);
    expect(screen.getByText(/is a variable/i)).toBeInTheDocument();
    expect(screen.getByText(/is one run/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add the first column/i })).toBeInTheDocument();
  });

  it("adds a column from the empty state", async () => {
    const onChange = vi.fn();
    render(<DatasetEditor dataset={emptyDataset()} onChange={onChange} />);

    await userEvent.click(screen.getByRole("button", { name: /add the first column/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].columns).toEqual(["column"]);
  });

  it("adds a column from the toolbar", async () => {
    const onChange = vi.fn();
    render(<DatasetEditor dataset={seed()} onChange={onChange} />);

    await userEvent.click(screen.getByRole("button", { name: "Column" }));

    expect(onChange.mock.calls[0][0].columns).toEqual(["email", "column"]);
  });

  it("renders column names in a header band, not as another data row", () => {
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);
    // The header cell is the column NAME; the data cell is the value.
    expect(screen.getByDisplayValue("email")).toBeInTheDocument();
    expect(screen.getByDisplayValue("a@x.com")).toBeInTheDocument();
    // The name box is styled as a label (borderless until hover), the value isn't.
    expect(screen.getByDisplayValue("email").className).toContain("border-transparent");
    expect(screen.getByDisplayValue("a@x.com").className).not.toContain("border-transparent");
  });

  it("reports a cell edit", async () => {
    const onChange = vi.fn();
    const d = seed();
    render(<DatasetEditor dataset={d} onChange={onChange} />);

    const cell = screen.getByDisplayValue("a@x.com");
    await userEvent.type(cell, "!");

    const next: Dataset = onChange.mock.calls.at(-1)![0];
    expect(next.rows[0].values.email).toBe("a@x.com!");
  });

  it("flags a column name that can't be used as a variable", () => {
    // {{expected status}} would never resolve — the regex is \w+ only.
    const d = addColumn(emptyDataset(), "expected status");
    render(<DatasetEditor dataset={d} onChange={vi.fn()} />);

    const input = screen.getByDisplayValue("expected status");
    expect(input.className).toContain("border-destructive");
  });

  it("does not flag a valid column name", () => {
    render(<DatasetEditor dataset={seed()} onChange={vi.fn()} />);
    expect(screen.getByDisplayValue("email").className).not.toContain("border-destructive");
  });

  it("removes a column and its cells", async () => {
    const onChange = vi.fn();
    render(<DatasetEditor dataset={seed()} onChange={onChange} />);

    await userEvent.click(screen.getByRole("button", { name: /remove column email/i }));

    const next: Dataset = onChange.mock.calls[0][0];
    expect(next.columns).toEqual([]);
    expect("email" in next.rows[0].values).toBe(false);
  });

  it("reveals per-row overrides on demand", async () => {
    const d = seed();
    render(<DatasetEditor dataset={d} onChange={vi.fn()} sharedAssertion="response.status == 200" />);

    expect(screen.queryByPlaceholderText("response.status == 201")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /show overrides/i }));

    // Both the payload selector and the check are in the expander.
    expect(screen.getByText("Payload")).toBeInTheDocument();
    expect(screen.getByText("Check")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("response.status == 201")).toBeInTheDocument();
    expect(screen.getByText(/uses the shared check/i)).toBeInTheDocument();
    // Shared is the default, so no body textarea until Custom is chosen.
    expect(screen.getByText(/uses the body from the request tab/i)).toBeInTheDocument();
  });

  it("shows a body textarea only for a custom payload", async () => {
    const d = seed();
    d.rows[0].payload_mode = "custom";
    d.rows[0].payload = '{"a":1}';
    render(<DatasetEditor dataset={d} onChange={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: /show overrides/i }));
    expect(screen.getByDisplayValue('{"a":1}')).toBeInTheDocument();
  });

  it("says no body will be sent when the mode is none", async () => {
    const d = seed();
    d.rows[0].payload_mode = "none";
    render(<DatasetEditor dataset={d} onChange={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: /show overrides/i }));
    expect(screen.getByText(/sends no body at all/i)).toBeInTheDocument();
  });

  it("marks a row that overrides something", () => {
    const d = seed();
    d.rows[0].payload_mode = "none";
    render(<DatasetEditor dataset={d} onChange={vi.fn()} />);
    // The collapsed chevron advertises what's overridden.
    expect(screen.getByRole("button", { name: /show overrides/i }).title).toContain("payload");
  });
});
