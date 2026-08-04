import { useCallback, useState } from "react";
import { railViewFrom, type RailView } from "@/lib/railViews";

/**
 * Which sidebar view the rail is on, remembered between sessions.
 *
 * Same shape as `useDensity`: read once, write through. Reopening a project lands where you
 * left it, because the view you want is a property of how you work rather than of the
 * project.
 */
const KEY = "sat.railView";

export function useRailView() {
  const [view, setViewState] = useState<RailView>(() => railViewFrom(localStorage.getItem(KEY)));

  const setView = useCallback((next: RailView) => {
    localStorage.setItem(KEY, next);
    setViewState(next);
  }, []);

  return { view, setView };
}
