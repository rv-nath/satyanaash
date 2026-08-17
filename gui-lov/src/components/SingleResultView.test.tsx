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

/**
 * How much of the panel you can actually read.
 *
 * This view is embedded in a run's split pane, where the chart and the step tree take most of
 * the window. Every block used to claim a fixed slice — status bar, logs with their own
 * scrollbar, exports, tab bar, a Wrap bar — and the response scrolled inside whatever remained:
 * on a 660px pane the body got about 120px, with its own scrollbar inside a pane that barely
 * scrolled. It also wore the test-case editor's type scale, which is a size larger than the run
 * tree beside it.
 */
describe("the panel's sizing, embedded in a run", () => {
  const big = (): TestCaseExecutionResult => ({
    ...result(Array.from({ length: 12 }, (_, i) => `line ${i}`)),
    status: "failed",
    error_message: "Expected HTTP 201, got 500",
    response: {
      status: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: 500, message: "Role ID and Role Name mismatch" }, null, 2),
      json: {},
    },
  });

  it("scrolls as one document rather than in a sliver", () => {
    const { container } = render(<SingleResultView {...props} result={big()} />);
    const scrollers = [...container.querySelectorAll<HTMLElement>("*")].filter((e) =>
      /overflow-y-auto|overflow-auto/.test(e.className.toString()),
    );
    // Exactly one vertical scroller: the panel itself.
    expect(scrollers).toHaveLength(1);
    expect(scrollers[0].className).toContain("flex-1");
  });

  it("gives the response body no scrollbar of its own", () => {
    const { container } = render(<SingleResultView {...props} result={big()} />);
    const pre = container.querySelector("pre")!;
    expect(pre.className).not.toMatch(/overflow-auto|overflow-y-auto/);
    // Long lines still scroll sideways rather than forcing the page to.
    expect(pre.className).toContain("overflow-x-auto");
  });

  it("wears the run view's type scale, not the editor's", () => {
    const { container } = render(<SingleResultView {...props} result={big()} />);
    expect(container.querySelector("pre")!.className).toContain("text-xs");
    // The verdict word and its detail line came down a step too.
    expect(screen.getByText(/expected http 201/i).className).toContain("text-xs");
  });

  it("keeps the verdict visible while the rest scrolls", () => {
    // The status bar sits outside the scroller, so scrolling the body never loses the verdict.
    const { container } = render(<SingleResultView {...props} result={big()} />);
    const scroller = [...container.querySelectorAll<HTMLElement>("*")].find((e) =>
      /overflow-y-auto/.test(e.className.toString()),
    )!;
    expect(scroller.contains(screen.getByText(/^failed$/i))).toBe(false);
  });
});
