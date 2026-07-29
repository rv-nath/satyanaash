import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StepControls } from "@/components/StepControls";

const props = {
  mode: "paused" as const,
  nextNodeName: "Login as PA",
  done: 3,
  total: 7,
  onStep: vi.fn(),
};

describe("StepControls", () => {
  it("stays out of the way when no run is being driven", () => {
    const { container } = render(<StepControls {...props} mode="idle" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says nothing during a plain run, which never pauses", () => {
    const { container } = render(<StepControls {...props} mode="finishing" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names what runs next and how far along the run is", () => {
    render(<StepControls {...props} />);
    expect(screen.getByText("Next up")).toBeInTheDocument();
    expect(screen.getByText("Login as PA")).toBeInTheDocument();
    expect(screen.getByText("3 of 7 done")).toBeInTheDocument();
  });

  it("sends the command that was pressed", async () => {
    const onStep = vi.fn();
    render(<StepControls {...props} onStep={onStep} />);

    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await userEvent.click(screen.getByRole("button", { name: /run to end/i }));
    await userEvent.click(screen.getByRole("button", { name: /stop/i }));

    expect(onStep.mock.calls.map(([c]) => c)).toEqual(["next", "run_to_end", "stop"]);
  });

  it("says what Stop actually does, since cleanup is not optional", () => {
    render(<StepControls {...props} />);
    expect(screen.getByRole("button", { name: /stop/i })).toHaveAttribute(
      "title",
      expect.stringMatching(/cleanup steps still run/i),
    );
  });

  it("offers nothing to press while a node is in flight", () => {
    render(<StepControls {...props} mode="running" />);
    expect(screen.getByText("Running")).toBeInTheDocument();
    for (const name of [/next/i, /run to end/i, /stop/i]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  });
});
