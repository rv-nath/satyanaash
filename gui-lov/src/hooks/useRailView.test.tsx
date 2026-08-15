import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { MemoryRouter, useSearchParams } from "react-router-dom";
import type { ReactNode } from "react";
import { useRailView } from "@/hooks/useRailView";

beforeEach(() => localStorage.clear());

/** The hook reads and writes the URL, so it needs a router the way it has one in the app. */
const at = (url: string) => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>
  );
  return renderHook(
    () => ({ rail: useRailView(), params: useSearchParams()[0] }),
    { wrapper },
  );
};

describe("useRailView", () => {
  it("defaults to the stacked Workspace view", () => {
    expect(at("/project/p1").result.current.rail.view).toBe("workspace");
  });

  it("remembers the view across a remount", () => {
    // Reopening a project should land where you left it — the view you want is a property
    // of how you work, not of the project.
    const first = at("/project/p1");
    act(() => first.result.current.rail.setView("runs"));
    expect(localStorage.getItem("sat.railView")).toBe("runs");

    expect(at("/project/p1").result.current.rail.view).toBe("runs");
  });

  it("does not wedge on a value it does not recognise", () => {
    // A blank sidebar with no way out except clearing storage is the failure this avoids.
    localStorage.setItem("sat.railView", "settings");
    expect(at("/project/p1").result.current.rail.view).toBe("workspace");

    localStorage.setItem("sat.railView", "{}");
    expect(at("/project/p1").result.current.rail.view).toBe("workspace");
  });

  describe("travelling in the URL", () => {
    it("puts the view in the URL, so a link reproduces what its author was looking at", () => {
      // The half lost when the rail replaced the old `?tab=` toggle: the view moved into
      // localStorage and stopped travelling, so a pasted link showed the sender's flow beside the
      // receiver's sidebar.
      const { result } = at("/project/p1?flow=f2");
      act(() => result.current.rail.setView("runs"));

      expect(result.current.params.get("rail")).toBe("runs");
      // And leaves the rest of the link alone.
      expect(result.current.params.get("flow")).toBe("f2");
    });

    it("takes the URL's view over the remembered one", () => {
      // Otherwise the link still would not reproduce the view — it would show whatever the
      // reader's browser last had.
      localStorage.setItem("sat.railView", "tests");
      expect(at("/project/p1?rail=suites").result.current.rail.view).toBe("suites");
    });

    it("falls back to the remembered view when the URL says nothing", () => {
      // A bare /project/:id carries no opinion, so storage should still decide.
      localStorage.setItem("sat.railView", "flows");
      expect(at("/project/p1").result.current.rail.view).toBe("flows");
    });

    it("ignores a view in the URL that this build does not know", () => {
      // A link from a future build, or a typo. Falling through to storage beats a blank sidebar.
      localStorage.setItem("sat.railView", "tests");
      expect(at("/project/p1?rail=settings").result.current.rail.view).toBe("tests");
      expect(at("/project/p1?rail=%7B%7D").result.current.rail.view).toBe("tests");
    });

    it("still writes storage, so the next visit without a link remembers", () => {
      const { result } = at("/project/p1?rail=tests");
      act(() => result.current.rail.setView("suites"));
      expect(localStorage.getItem("sat.railView")).toBe("suites");
    });
  });
});
