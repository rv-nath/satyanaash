import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceTabs, type RenderTab } from "@/components/WorkspaceTabs";

const tabs: RenderTab[] = [
  { key: "flow:f1", kind: "flow", label: "Login flow" },
  { key: "test:t1", kind: "test", label: "Get Users", method: "GET" },
];

describe("WorkspaceTabs", () => {
  it("renders nothing selectable when empty", () => {
    render(<WorkspaceTabs tabs={[]} settingsOpen={false} active={null} onActivate={() => {}} onClose={() => {}} />);
    expect(screen.queryByText("Login flow")).not.toBeInTheDocument();
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
  });

  it("renders a tab per open flow/test and fires callbacks", async () => {
    const onActivate = vi.fn();
    const onClose = vi.fn();
    render(<WorkspaceTabs tabs={tabs} settingsOpen={false} active="test:t1" onActivate={onActivate} onClose={onClose} />);
    await userEvent.click(screen.getByText("Login flow"));
    expect(onActivate).toHaveBeenCalledWith("flow:f1");
    await userEvent.click(screen.getByLabelText("close test:t1"));
    expect(onClose).toHaveBeenCalledWith("test:t1");
  });

  it("renders a closable Settings tab when settingsOpen", async () => {
    const onClose = vi.fn();
    render(<WorkspaceTabs tabs={[]} settingsOpen active="settings" onActivate={() => {}} onClose={onClose} />);
    expect(screen.getByText("Settings")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("close settings"));
    expect(onClose).toHaveBeenCalledWith("settings");
  });
});
