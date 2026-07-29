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

  it("renames on double-click, committed with Enter", async () => {
    const onRename = vi.fn();
    render(
      <WorkspaceTabs tabs={tabs} settingsOpen={false} active="flow:f1" onActivate={() => {}} onClose={() => {}} onRename={onRename} />,
    );

    await userEvent.dblClick(screen.getByText("Login flow"));
    const field = screen.getByLabelText("rename flow:f1");
    // Opens with the current name, so a small correction doesn't mean retyping it.
    expect(field).toHaveValue("Login flow");

    await userEvent.clear(field);
    await userEvent.type(field, "Signup flow{Enter}");
    expect(onRename).toHaveBeenCalledWith("flow:f1", "Signup flow");
    expect(screen.queryByLabelText("rename flow:f1")).not.toBeInTheDocument();
  });

  it("abandons the rename on Escape", async () => {
    const onRename = vi.fn();
    render(
      <WorkspaceTabs tabs={tabs} settingsOpen={false} active="flow:f1" onActivate={() => {}} onClose={() => {}} onRename={onRename} />,
    );
    await userEvent.dblClick(screen.getByText("Login flow"));
    await userEvent.type(screen.getByLabelText("rename flow:f1"), "nonsense{Escape}");
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText("Login flow")).toBeInTheDocument();
  });

  it("commits on blur, the way the inline group rename does", async () => {
    const onRename = vi.fn();
    render(
      <WorkspaceTabs tabs={tabs} settingsOpen={false} active="flow:f1" onActivate={() => {}} onClose={() => {}} onRename={onRename} />,
    );
    await userEvent.dblClick(screen.getByText("Login flow"));
    await userEvent.type(screen.getByLabelText("rename flow:f1"), " v2");
    await userEvent.tab();
    expect(onRename).toHaveBeenCalledWith("flow:f1", "Login flow v2");
  });

  it("writes nothing for a blank or unchanged name", async () => {
    const onRename = vi.fn();
    render(
      <WorkspaceTabs tabs={tabs} settingsOpen={false} active="flow:f1" onActivate={() => {}} onClose={() => {}} onRename={onRename} />,
    );

    // Blank would leave a tab you can't read.
    await userEvent.dblClick(screen.getByText("Login flow"));
    await userEvent.clear(screen.getByLabelText("rename flow:f1"));
    await userEvent.keyboard("{Enter}");
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText("Login flow")).toBeInTheDocument();

    // Unchanged isn't worth a request.
    await userEvent.dblClick(screen.getByText("Login flow"));
    await userEvent.keyboard("{Enter}");
    expect(onRename).not.toHaveBeenCalled();
  });

  it("renames a test tab too", async () => {
    const onRename = vi.fn();
    render(
      <WorkspaceTabs tabs={tabs} settingsOpen={false} active="test:t1" onActivate={() => {}} onClose={() => {}} onRename={onRename} />,
    );
    await userEvent.dblClick(screen.getByText("Get Users"));
    await userEvent.clear(screen.getByLabelText("rename test:t1"));
    await userEvent.type(screen.getByLabelText("rename test:t1"), "List Users{Enter}");
    expect(onRename).toHaveBeenCalledWith("test:t1", "List Users");
  });

  it("leaves a tab with nothing to rename alone", async () => {
    const onRename = vi.fn();
    // An unsaved New Test has no record on the server yet.
    const unsaved: RenderTab[] = [
      { key: "test:__new__", kind: "test", label: "New Test", method: "NEW", renameable: false },
    ];
    render(
      <WorkspaceTabs tabs={unsaved} settingsOpen={false} active="test:__new__" onActivate={() => {}} onClose={() => {}} onRename={onRename} />,
    );
    await userEvent.dblClick(screen.getByText("New Test"));
    expect(screen.queryByLabelText("rename test:__new__")).not.toBeInTheDocument();
  });

  it("does nothing on double-click when renaming isn't offered", async () => {
    render(<WorkspaceTabs tabs={tabs} settingsOpen={false} active="flow:f1" onActivate={() => {}} onClose={() => {}} />);
    await userEvent.dblClick(screen.getByText("Login flow"));
    expect(screen.queryByLabelText("rename flow:f1")).not.toBeInTheDocument();
  });

  it("renders a closable Settings tab when settingsOpen", async () => {
    const onClose = vi.fn();
    render(<WorkspaceTabs tabs={[]} settingsOpen active="settings" onActivate={() => {}} onClose={onClose} />);
    expect(screen.getByText("Settings")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("close settings"));
    expect(onClose).toHaveBeenCalledWith("settings");
  });
});
