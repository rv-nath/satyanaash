import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SingleResultView } from "@/components/TestCaseEditor";
import type { TestCaseExecutionResult } from "@/lib/api/types";

const result = (logs: string[]): TestCaseExecutionResult => ({
  node_id: "direct",
  status: "passed",
  duration_ms: 12,
  logs,
  request: {
    method: "GET",
    url: "http://host/api/v1/campaigns/sms/pause/abcd1234/{{recurrenceId}}",
    headers: {},
  },
  response: { status: 200, headers: {}, body: "{}", json: {} },
});

const props = {
  wordWrap: false,
  setWordWrap: vi.fn(),
  onRerun: vi.fn(),
  onClear: vi.fn(),
  running: false,
};

describe("SingleResultView", () => {
  it("shows what the engine warned about, not just the response", () => {
    // The engine reported this and the UI used to drop it, so the only clue was
    // the raw URL in the Request tab.
    render(
      <SingleResultView
        {...props}
        result={result(["⚠ Unresolved variable(s) sent literally: {{recurrenceId}}"])}
      />,
    );
    const note = screen.getByText(/unresolved variable/i);
    expect(note).toBeInTheDocument();
    // Warnings read as warnings.
    expect(note.className).toContain("text-warning");
  });

  it("shows plain notes too, like script output", () => {
    render(<SingleResultView {...props} result={result(["status was 200"])} />);
    expect(screen.getByText("status was 200")).toBeInTheDocument();
  });

  it("stays quiet when the engine said nothing", () => {
    render(<SingleResultView {...props} result={result([])} />);
    expect(screen.queryByText(/unresolved/i)).not.toBeInTheDocument();
  });
});
