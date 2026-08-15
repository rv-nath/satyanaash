import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { railViewFrom, type RailView } from "@/lib/railViews";

/**
 * Which sidebar view the rail is on — in the URL, and remembered between sessions.
 *
 * **The URL wins when it says anything**, so a link reproduces the view its author was looking
 * at. That is the half this lost when the rail replaced the old `?tab=` sidebar toggle: the view
 * moved into `localStorage` and stopped travelling, so a pasted link showed the sender's flow
 * beside the receiver's sidebar — the same "not in sync" that `?flow=` was fixed for.
 *
 * `localStorage` stays as the fallback rather than being replaced, because reopening a project
 * from scratch should still land where you left it: the view you want is a property of how you
 * work, and a bare `/project/:id` carries no opinion about it.
 */
const KEY = "sat.railView";
const PARAM = "rail";

/** A URL value this build knows, or nothing. Unrecognised falls through to storage rather than
 *  wedging the sidebar on a view with nothing in it — the reason `railViewFrom` exists. */
function fromUrl(params: URLSearchParams): RailView | null {
  const raw = params.get(PARAM);
  return raw && railViewFrom(raw) === raw ? (raw as RailView) : null;
}

export function useRailView() {
  const [searchParams, setSearchParams] = useSearchParams();

  const [view, setViewState] = useState<RailView>(
    () => fromUrl(searchParams) ?? railViewFrom(localStorage.getItem(KEY)),
  );

  const setView = useCallback(
    (next: RailView) => {
      localStorage.setItem(KEY, next);
      setViewState(next);
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set(PARAM, next);
          return params;
        },
        // Replace, so switching sidebars does not fill the back button with sidebar changes.
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // Back/forward to a URL naming a different view. Guarded by what was last seen rather than by
  // the current state, so this cannot fight `setView`'s own write on the render after it.
  const seen = useRef<string | null>(searchParams.get(PARAM));
  useEffect(() => {
    const raw = searchParams.get(PARAM);
    if (raw === seen.current) return;
    seen.current = raw;
    const next = fromUrl(searchParams);
    if (next) setViewState(next);
  }, [searchParams]);

  return { view, setView };
}
