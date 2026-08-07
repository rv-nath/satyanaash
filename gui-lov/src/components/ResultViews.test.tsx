import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TestCaseExecutionResult } from "@/lib/api/types";
import { DatasetResultView, SingleResultView } from "@/components/TestCaseEditor";

/**
 * The two result views, which had no test at all.
 *
 * `TestCaseEditor.tsx` exports both and is otherwise untested, so a change to either was
 * only ever verified by opening the app. That is how a blank page once survived a full green
 * suite, a clean `tsc` and a production build.
 */

const result = (over: Partial<TestCaseExecutionResult> = {}): TestCaseExecutionResult =>
  ({
    node_id: "n1",
    test_case_name: "Launch",
    status: "passed",
    duration_ms: 120,
    logs: [],
    response: { status: 202, headers: {}, body: '{"ok":true}' },
    ...over,
  }) as TestCaseExecutionResult;

const row = (i: number, label: string): TestCaseExecutionResult =>
  result({ row_index: i, row_label: label, status: "passed" });

const noop = () => {};

describe("a single request's result", () => {
  it("shows what it exported, with the value on the closed line", () => {
    // Exports were rendered nowhere in the run history. Survivable while an export was a
    // scalar sitting in the response body on screen beside it; not survivable once a step's
    // whole product is something assembled from several responses.
    const { container } = render(
      <SingleResultView
        result={result({ exports: { user_id: "42" } })}
        wordWrap={false}
        setWordWrap={noop}
        running={false}
      />,
    );
    // The closed line carries the value, so a scalar needs no interaction at all.
    const summary = container.querySelector("summary");
    expect(summary?.textContent).toContain("exported");
    expect(summary?.textContent).toContain("user_id");
    expect(summary?.textContent).toContain("42");
  });

  it("says nothing when a step exported nothing", () => {
    render(
      <SingleResultView result={result()} wordWrap={false} setWordWrap={noop} running={false} />,
    );
    expect(screen.queryByText(/exported/)).not.toBeInTheDocument();
  });
});

describe("a step that ran more than once", () => {
  const aggregate = (over: Partial<TestCaseExecutionResult> = {}) =>
    result({
      iterations: [row(0, "10 recipients"), row(1, "100 recipients")],
      ...over,
    });

  it("shows each row's collected values against that row", () => {
    // Interleaved rather than gathered into one block: the row and what it produced are the
    // same fact, and splitting them made the reader cross-reference a `_row` field.
    const records = [
      { campaignId: "c-8871", txnId: "t-41", _row: "10 recipients" },
      { campaignId: "c-8872", txnId: "t-42", _row: "100 recipients" },
    ];
    render(
      <DatasetResultView
        aggregate={aggregate({ exports: { campaign_info: records } })}
        selected={null}
        onSelect={noop}
        wordWrap={false}
        setWordWrap={noop}
        running={false}
      />,
    );

    // Each id is in the same table row as the case that produced it.
    const cell = screen.getByText("100 recipients").closest("td");
    expect(cell?.textContent).toContain("c-8872");
    expect(cell?.textContent).toContain("t-42");
    expect(cell?.textContent).not.toContain("c-8871");
    // The bookkeeping field is not shown as one of them.
    expect(cell?.textContent).not.toContain("_row");
  });

  it("calls its iterations rows for a dataset and items for a walked list", () => {
    const { unmount } = render(
      <DatasetResultView
        aggregate={aggregate()}
        selected={null}
        onSelect={noop}
        wordWrap={false}
        setWordWrap={noop}
        running={false}
      />,
    );
    expect(screen.getByText("2 rows")).toBeInTheDocument();
    unmount();

    // A step walking a collected list has no rows, and saying it does is a small lie in the
    // one place an author looks to find out what ran.
    render(
      <DatasetResultView
        aggregate={aggregate({ iterations_of: "item" })}
        selected={null}
        onSelect={noop}
        wordWrap={false}
        setWordWrap={noop}
        running={false}
      />,
    );
    expect(screen.getByText("2 items")).toBeInTheDocument();
    expect(screen.queryByText("2 rows")).not.toBeInTheDocument();
  });

  it("labels each iteration by the row that produced it", () => {
    render(
      <DatasetResultView
        aggregate={aggregate({ iterations_of: "item" })}
        selected={null}
        onSelect={noop}
        wordWrap={false}
        setWordWrap={noop}
        running={false}
      />,
    );
    // Carried through from `_row` on the record, so a failure names the campaign rather than
    // an index.
    expect(screen.getByText("100 recipients")).toBeInTheDocument();
  });
});
