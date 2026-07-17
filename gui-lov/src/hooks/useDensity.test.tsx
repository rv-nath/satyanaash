import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDensity } from "@/hooks/useDensity";

beforeEach(() => localStorage.clear());

describe("useDensity", () => {
  it("defaults to compact and reflects it on <html>", () => {
    const { result } = renderHook(() => useDensity());
    expect(result.current.density).toBe("compact");
    expect(document.documentElement.getAttribute("data-density")).toBe("compact");
  });

  it("persists a change to localStorage", () => {
    const { result } = renderHook(() => useDensity());
    act(() => result.current.setDensity("comfortable"));
    expect(result.current.density).toBe("comfortable");
    expect(localStorage.getItem("sat.density")).toBe("comfortable");
    expect(document.documentElement.getAttribute("data-density")).toBe("comfortable");
  });
});
