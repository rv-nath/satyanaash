import "@testing-library/jest-dom/vitest";

// jsdom lacks these APIs that Radix/React-Flow touch during render.

// Radix's ScrollArea observes its content to size the thumb. Nothing measures anything
// in jsdom, so a no-op is enough — without it, any test that grows the content inside a
// scroll area dies on a missing global rather than on anything it was checking.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList;
}
