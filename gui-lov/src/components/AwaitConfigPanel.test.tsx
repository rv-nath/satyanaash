import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The panel for a step that waits for a callback.
 *
 * The summary lines are pinned in `lib/nodeConfig.test.ts`; this covers what only a render can
 * show — that seconds in the boxes reach the wire as milliseconds, that the config is written
 * under the key the engine reads, and that the palette hands the canvas a droppable node.
 */

const updateNodeConfig = vi.fn();
vi.mock("@/contexts/TestProjectContext", () => ({
  useTestProject: () => ({ updateNodeConfig }),
}));

import { AwaitConfigPanel } from "@/components/AwaitConfigPanel";
import { StepPalette } from "@/components/StepPalette";

const node = (config: Record<string, unknown> = {}) =>
  ({ id: "w1", type: "awaitCallback", position: { x: 0, y: 0 }, data: { config } }) as never;

beforeEach(() => vi.clearAllMocks());

describe("configuring a wait", () => {
  it("writes the path, count and timeout where the engine reads them", async () => {
    render(<AwaitConfigPanel node={node()} onClose={vi.fn()} />);

    // Pasted, not typed: `{{` is userEvent's own escape syntax and would arrive as a single
    // brace — which is the one thing this test is checking survives.
    await userEvent.click(screen.getByLabelText("Path"));
    await userEvent.paste("dr/{{dr_path}}");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    const [id, config] = updateNodeConfig.mock.calls[0];
    expect(id).toBe("w1");
    // `awaitCallback` is what the engine and the validator both look under. A near-miss here
    // saves a node that reads as configured and waits on nothing.
    expect(config.awaitCallback).toMatchObject({ path: "dr/{{dr_path}}", count: 1 });
  });

  it("sends the timeout in milliseconds although it is typed in seconds", async () => {
    // The engine's field is `timeoutMs`. Typing 30 and saving 30 would give a 30ms wait, which
    // fails instantly and reads exactly like a callback that never came.
    render(<AwaitConfigPanel node={node()} onClose={vi.fn()} />);

    const timeout = screen.getByLabelText("Give up after");
    await userEvent.clear(timeout);
    await userEvent.type(timeout, "30");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(updateNodeConfig.mock.calls[0][1].awaitCallback.timeoutMs).toBe(30000);
  });

  it("shows an existing wait in seconds, not milliseconds", () => {
    render(
      <AwaitConfigPanel
        node={node({ awaitCallback: { path: "dr/x", count: 2, timeoutMs: 45000 } })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Give up after")).toHaveValue(45);
    expect(screen.getByLabelText("How many")).toHaveValue(2);
    expect(screen.getByLabelText("Path")).toHaveValue("dr/x");
  });

  it("opens a cleared 0 as the default it will behave as", () => {
    // Otherwise the panel says 0 and the engine waits 60s — two answers about one node.
    render(
      <AwaitConfigPanel
        node={node({ awaitCallback: { path: "dr/x", count: 0, timeoutMs: 0 } })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("How many")).toHaveValue(1);
    expect(screen.getByLabelText("Give up after")).toHaveValue(60);
  });

  it("keeps the Expect, which is what makes a wait more than an arrival check", async () => {
    render(<AwaitConfigPanel node={node()} onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Expect"), "response.json.status == 1");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updateNodeConfig.mock.calls[0][1].check).toBe("response.json.status == 1");
  });

  it("takes a field out of the callback for a later step", async () => {
    render(<AwaitConfigPanel node={node()} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /add/i }));
    await userEvent.type(screen.getByLabelText("Output variable 1 name"), "delivered_id");
    await userEvent.type(screen.getByLabelText("Output variable 1 path"), "$.messageId");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(updateNodeConfig.mock.calls[0][1].outputVars).toEqual([
      { name: "delivered_id", path: "$.messageId" },
    ]);
  });

  it("omits the match when blank, rather than storing an empty condition", async () => {
    // A dormant condition would read as one in force.
    render(<AwaitConfigPanel node={node()} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updateNodeConfig.mock.calls[0][1].awaitCallback).not.toHaveProperty("match");
  });

  it("keeps the correlation match when one is written", async () => {
    render(<AwaitConfigPanel node={node()} onClose={vi.fn()} />);
    // Pasted, not typed: `{{` is userEvent's own escape syntax.
    await userEvent.click(screen.getByLabelText("Which callback is mine"));
    await userEvent.paste('response.query.cTxnId == "{{cTxnId}}"');
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updateNodeConfig.mock.calls[0][1].awaitCallback.match).toBe(
      'response.query.cTxnId == "{{cTxnId}}"',
    );
  });

  it("shows an existing match", () => {
    render(
      <AwaitConfigPanel
        node={node({ awaitCallback: { path: "dr/x", match: "response.query.id == \"7\"" } })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Which callback is mine")).toHaveValue(
      'response.query.id == "7"',
    );
  });

  it("writes forEach only when set to run per item", async () => {
    // A dormant `forEach` would read, to the engine and to the next author, as a step that walks
    // a list — the same rule the request node's run mode follows.
    render(<AwaitConfigPanel node={node()} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updateNodeConfig.mock.calls[0][1]).not.toHaveProperty("forEach");
  });

  it("walks a collected list, one wait per item", async () => {
    render(<AwaitConfigPanel node={node()} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("radio", { name: /once per item/i }));
    await userEvent.type(screen.getByLabelText("List to walk"), "sent");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updateNodeConfig.mock.calls[0][1].forEach).toEqual({ list: "sent" });
  });

  it("forgives braces on the list name, as the engine does", async () => {
    // Everyone writes {{sent}}, because that is how a variable is written everywhere else.
    render(<AwaitConfigPanel node={node()} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("radio", { name: /once per item/i }));
    await userEvent.click(screen.getByLabelText("List to walk"));
    await userEvent.paste("{{sent}}");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updateNodeConfig.mock.calls[0][1].forEach).toEqual({ list: "sent" });
  });

  it("opens showing the list it already walks", () => {
    render(
      <AwaitConfigPanel
        node={node({ awaitCallback: { path: "dr/x" }, forEach: { list: "sent" } })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("List to walk")).toHaveValue("sent");
  });

  it("hides the list box when it runs once", () => {
    render(<AwaitConfigPanel node={node()} onClose={vi.fn()} />);
    expect(screen.queryByLabelText("List to walk")).not.toBeInTheDocument();
  });

  it("says the step cannot run while it has no path", () => {
    render(<AwaitConfigPanel node={node()} onClose={vi.fn()} />);
    expect(screen.getByText(/cannot run without one/i)).toBeInTheDocument();
  });

  it("abandons the edit on Cancel without touching the node", async () => {
    const onClose = vi.fn();
    render(<AwaitConfigPanel node={node()} onClose={onClose} />);
    await userEvent.type(screen.getByLabelText("Path"), "dr/half-typed");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(updateNodeConfig).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

describe("the steps palette", () => {
  it("hands the canvas the type and defaults it needs to drop a node", () => {
    // It rides the channel the test-case and flow drags already use, so `handleDrop` and
    // `addNodeToCanvas` took it unchanged — but only if the payload keeps their shape.
    render(<StepPalette />);
    const setData = vi.fn();
    const chip = screen.getByTitle(/drag onto the canvas/i);

    const { fireEvent } = require("@testing-library/react");
    fireEvent.dragStart(chip, { dataTransfer: { setData } });

    const [channel, raw] = setData.mock.calls[0];
    expect(channel).toBe("application/json");
    const payload = JSON.parse(raw);
    expect(payload.type).toBe("awaitCallback");
    // Defaults that match the engine's, so a freshly dropped node shows what it will do rather
    // than blanks that read as unset and behave as 1 and 60s.
    expect(payload.data.config.awaitCallback).toEqual({ count: 1, timeoutMs: 60000 });
  });
});
