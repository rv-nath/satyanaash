import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Node } from "@xyflow/react";

const updateNodeConfig = vi.fn();
vi.mock("@/contexts/TestProjectContext", () => ({
  useTestProject: () => ({ updateNodeConfig }),
}));

import { NodeConfigPanel } from "@/components/NodeConfigPanel";

const node = (config: Record<string, unknown> = {}): Node => ({
  id: "n1",
  type: "testCase",
  position: { x: 0, y: 0 },
  data: { label: "Delete User", method: "DELETE", endpoint: "{{baseUrl}}/accounts/{{id}}", config },
});

describe("NodeConfigPanel", () => {
  beforeEach(() => updateNodeConfig.mockReset());

  it("saves the Runs choice as the flag the engine reads", async () => {
    render(<NodeConfigPanel node={node()} onClose={vi.fn()} />);

    // Defaults to running in the flow, where it was placed.
    await userEvent.click(screen.getByRole("radio", { name: /at the end/i }));
    await userEvent.click(screen.getByRole("button", { name: /save configuration/i }));

    const [, config] = updateNodeConfig.mock.calls[0];
    expect(config.teardown).toBe(true);
  });

  it("reads an existing teardown node back as At the end", () => {
    render(<NodeConfigPanel node={node({ teardown: true })} onClose={vi.fn()} />);
    expect(screen.getByRole("radio", { name: /at the end/i })).toHaveAttribute(
      "data-state",
      "on",
    );
  });

  it("explains Expect according to what is in it", async () => {
    render(<NodeConfigPanel node={node()} onClose={vi.fn()} />);
    expect(screen.getByText(/blank uses the request's own assertion/i)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/^expect$/i), "402");
    expect(screen.getByText(/shorthand for response.status == 402/i)).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText(/^expect$/i));
    await userEvent.type(screen.getByLabelText(/^expect$/i), "response.json.ok");
    expect(screen.getByText(/rhai expression/i)).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<NodeConfigPanel node={node()} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
