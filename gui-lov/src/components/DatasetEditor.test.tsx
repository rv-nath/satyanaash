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
  it("prompts to add a column when empty", () => {
    render(<DatasetEditor dataset={emptyDataset()} onChange={vi.fn()} />);
    expect(screen.getByText(/add a column to start/i)).toBeInTheDocument();
  });

  it("adds a column", async () => {
    const onChange = vi.fn();
    render(<DatasetEditor dataset={emptyDataset()} onChange={onChange} />);

    await userEvent.click(screen.getByRole("button", { name: /column/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].columns).toEqual(["column"]);
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

  it("reveals a per-row assertion box on demand", async () => {
    const d = seed();
    render(<DatasetEditor dataset={d} onChange={vi.fn()} sharedAssertion="response.status == 200" />);

    expect(screen.queryByPlaceholderText("response.status == 201")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /show assertion/i }));

    expect(screen.getByPlaceholderText("response.status == 201")).toBeInTheDocument();
    expect(screen.getByText(/uses the shared check/i)).toBeInTheDocument();
  });
});
