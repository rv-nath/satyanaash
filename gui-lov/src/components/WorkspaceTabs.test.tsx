import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceTabs } from "@/components/WorkspaceTabs";

describe("WorkspaceTabs", () => {
  const tests = [{ id: "t1", name: "Get Users", method: "GET" }];

  it("always renders a pinned, non-closable canvas tab", () => {
    render(<WorkspaceTabs openTestIds={[]} active="canvas"
      tests={[]} onActivate={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/flow/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("close canvas")).not.toBeInTheDocument();
  });

  it("renders a closable tab per open test and fires callbacks", async () => {
    const onActivate = vi.fn();
    const onClose = vi.fn();
    render(<WorkspaceTabs openTestIds={["t1"]} active="t1"
      tests={tests} onActivate={onActivate} onClose={onClose} />);
    await userEvent.click(screen.getByText("Get Users"));
    expect(onActivate).toHaveBeenCalledWith("t1");
    await userEvent.click(screen.getByLabelText("close t1"));
    expect(onClose).toHaveBeenCalledWith("t1");
  });
});
