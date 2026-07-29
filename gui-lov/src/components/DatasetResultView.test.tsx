import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DatasetResultView } from "@/components/TestCaseEditor";
import type { TestCaseExecutionResult } from "@/lib/api/types";

/** Mirrors what the server returns for a "run all rows" with one failing row. */
function aggregate(): TestCaseExecutionResult {
  const row: TestCaseExecutionResult = {
    node_id: "direct",
    test_case_id: "tc1",
    test_case_name: "SignUp API",
    status: "failed",
    duration_ms: 3226,
    row_index: 0,
    row_label: "Empty Payload {}",
    request: {
      method: "POST",
      url: "http://127.0.0.1:32606/v1/accounts",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
    response: { status: 201, headers: { server: "nginx" }, body: '{"id":1}' },
    error_message: "Assertion returned false: response.status == data.expected_status",
    logs: [],
  };
  return {
    node_id: "direct",
    status: "failed",
    duration_ms: 3226,
    logs: [],
    error_message: "1 of 1 rows did not pass",
    iterations: [row],
  };
}

describe("DatasetResultView", () => {
  it("says what a passing row required, where a failure shows its reason", () => {
    // The column used to be empty on a green run, and two rows with the same name but
    // different expectations were indistinguishable.
    const passing: TestCaseExecutionResult = {
      node_id: "direct",
      status: "passed",
      duration_ms: 21,
      logs: [],
      row_index: 0,
      row_label: "email and password",
      expected: "HTTP 401",
      response: { status: 401, headers: {}, body: "{}" },
    };
    const failing: TestCaseExecutionResult = {
      node_id: "direct",
      status: "failed",
      duration_ms: 7,
      logs: [],
      row_index: 1,
      row_label: "email and password",
      expected: "HTTP 200",
      error_message: "Expected HTTP 200, got 401",
      response: { status: 401, headers: {}, body: "{}" },
    };
    render(
      <DatasetResultView
        aggregate={{
          node_id: "direct", status: "failed", duration_ms: 28, logs: [],
          iterations: [passing, failing],
        }}
        selected={null} onSelect={vi.fn()}
        wordWrap onRerun={vi.fn()} onClear={vi.fn()} running={false}
        setWordWrap={vi.fn()}
      />,
    );

    expect(screen.getByText("expected HTTP 401")).toBeInTheDocument();
    // A failing row keeps its reason — the requirement is implied by it.
    expect(screen.getByText("Expected HTTP 200, got 401")).toBeInTheDocument();
    expect(screen.queryByText("expected HTTP 200")).not.toBeInTheDocument();
  });

  it("lists the rows", () => {
    render(
      <DatasetResultView
        aggregate={aggregate()} selected={null} onSelect={vi.fn()}
        wordWrap onRerun={vi.fn()} onClear={vi.fn()} running={false}
        setWordWrap={vi.fn()}
      />
    );
    expect(screen.getByText("Empty Payload {}")).toBeInTheDocument();
    expect(screen.getByText("201")).toBeInTheDocument();
  });

  it("drills into a row without crashing", () => {
    // Regression: clicking a result row blanked the whole page.
    render(
      <DatasetResultView
        aggregate={aggregate()} selected={0} onSelect={vi.fn()}
        wordWrap onRerun={vi.fn()} onClear={vi.fn()} running={false}
        setWordWrap={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: /all rows/i })).toBeInTheDocument();
    expect(screen.getByText("1 / 1")).toBeInTheDocument();
  });
});
