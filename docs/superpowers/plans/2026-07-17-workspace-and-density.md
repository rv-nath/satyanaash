# Workspace & Density Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Tests/Flows sidebar tab-toggle and full-screen test-editor swap with a stacked resizable rail plus a tabbed workspace, and apply a compact density/typography pass — all in `gui-lov/` (no backend changes).

**Architecture:** Introduce a Vitest + Testing-Library harness (none exists today). Extract workspace-tab logic into a pure, unit-tested module, then drive a new tabbed workspace from context. The left panel becomes a vertical `ResizablePanelGroup` holding always-visible Flows and Tests sections with compact single-line rows and a name-anchored hover popover. Density is tuned via CSS/Tailwind tokens.

**Tech Stack:** React 18, TypeScript, Vite, Tailwind, shadcn/ui, @xyflow/react, react-router-dom v6, TanStack Query. Tests: Vitest + @testing-library/react + jsdom.

**Companion specs:** `docs/superpowers/specs/2026-07-17-ux-flow-test-workspace-redesign.md` (sections 1–6). Groups (section 7) and Tags are Plans 2 and 3, authored after this plan lands.

## Global Constraints

- Frontend only — no changes under `api/`.
- Density default is **Compact**; provide a Comfortable/Compact toggle persisted per-user in `localStorage`.
- UI chrome base font size **13px**; canvas/editor content font sizes unchanged.
- Rail width fixed **280px** default, min **220px**, max **400px** (not a screen percentage).
- Rail item names: Inter (UI font, **not** monospace), weight **400**, resting color `hsl(180 5% 72%)`; brighten to full/primary only on hover/active.
- Open test-case tabs **persist** across flow switches; the canvas tab is **pinned** (not closable).
- Preserve existing behavior: drag test onto canvas, autosave, validation, execution/console streaming, undo/redo.
- Commit after every task. Use `feat:`/`fix:`/`chore:`/`test:` prefixes (repo convention).
- Run from `gui-lov/`: `npm run lint` and `npm test` must pass before each commit.

---

## File Structure

- Create `gui-lov/vitest.config.ts` — test runner config (jsdom, globals).
- Create `gui-lov/src/test/setup.ts` — Testing-Library matchers + jsdom shims.
- Create `gui-lov/src/lib/workspaceTabs.ts` — pure tab-state module (open/close/switch).
- Create `gui-lov/src/lib/workspaceTabs.test.ts` — unit tests for the above.
- Create `gui-lov/src/components/WorkspaceTabs.tsx` — the tab bar UI.
- Create `gui-lov/src/components/TestRowPopover.tsx` — name-anchored hover popover.
- Create `gui-lov/src/hooks/useDensity.ts` — Comfortable/Compact toggle (+ test).
- Modify `gui-lov/package.json` — add test deps + `test` script.
- Modify `gui-lov/src/index.css` — density tokens, 13px chrome base, rail name color.
- Modify `gui-lov/src/contexts/TestProjectContext.tsx` — workspace-tab state wiring.
- Modify `gui-lov/src/pages/ProjectDetail.tsx` — stacked rail + tabbed workspace; remove Tabs toggle + full-screen swap.
- Modify `gui-lov/src/components/TestInventory.tsx` — compact rows + popover; drop bold/mono names.
- Modify `gui-lov/src/components/FlowsList.tsx` — compact rows; drop bold names.
- Modify `gui-lov/src/components/TestCaseEditor.tsx` — render inside a workspace tab (Task 7); optional response drawer (Task 8).

---

## Task 1: Test harness (Vitest + Testing-Library)

**Files:**
- Modify: `gui-lov/package.json`
- Create: `gui-lov/vitest.config.ts`
- Create: `gui-lov/src/test/setup.ts`
- Create: `gui-lov/src/lib/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` runs Vitest in jsdom with `@testing-library/jest-dom` matchers and the `@/` path alias.

- [ ] **Step 1: Install test dependencies**

Run (from `gui-lov/`):
```bash
npm install -D vitest@^2 jsdom@^25 @testing-library/react@^16 @testing-library/jest-dom@^6 @testing-library/user-event@^14
```
Expected: packages added to `devDependencies`; no peer-dependency errors that abort install.

- [ ] **Step 2: Add the `test` script**

In `gui-lov/package.json`, add to `"scripts"`:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Create `gui-lov/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
```
Note: `@vitejs/plugin-react-swc` is already a dev dependency (used by `vite.config.ts`). Reuse it.

- [ ] **Step 4: Create `gui-lov/src/test/setup.ts`**

```ts
import "@testing-library/jest-dom/vitest";

// jsdom lacks these APIs that Radix/React-Flow touch during render.
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
```

- [ ] **Step 5: Write a smoke test — `gui-lov/src/lib/smoke.test.ts`**

```ts
import { describe, it, expect } from "vitest";

describe("test harness", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 6: Run the harness**

Run: `npm test`
Expected: PASS — 1 passed. If it fails to resolve `@vitejs/plugin-react-swc`, confirm it exists in `devDependencies` (`grep react-swc package.json`).

- [ ] **Step 7: Commit**

```bash
git add gui-lov/package.json gui-lov/package-lock.json gui-lov/vitest.config.ts gui-lov/src/test/setup.ts gui-lov/src/lib/smoke.test.ts
git commit -m "test: add vitest + testing-library harness"
```

---

## Task 2: Workspace-tab state module (pure, TDD)

**Files:**
- Create: `gui-lov/src/lib/workspaceTabs.ts`
- Test: `gui-lov/src/lib/workspaceTabs.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Type `WorkspaceTab = "canvas" | string` (string = test-case id).
  - Type `WorkspaceState = { openTestIds: string[]; active: WorkspaceTab }`.
  - `initialWorkspaceState(): WorkspaceState`
  - `openTestTab(state: WorkspaceState, id: string): WorkspaceState`
  - `closeTestTab(state: WorkspaceState, id: string): WorkspaceState`
  - `setActive(state: WorkspaceState, tab: WorkspaceTab): WorkspaceState`
  - `switchFlow(state: WorkspaceState): WorkspaceState`  (keeps open test tabs, forces active → "canvas")

- [ ] **Step 1: Write failing tests — `gui-lov/src/lib/workspaceTabs.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import {
  initialWorkspaceState, openTestTab, closeTestTab, setActive, switchFlow,
} from "@/lib/workspaceTabs";

describe("workspaceTabs", () => {
  it("starts on the pinned canvas tab with no open tests", () => {
    const s = initialWorkspaceState();
    expect(s.active).toBe("canvas");
    expect(s.openTestIds).toEqual([]);
  });

  it("opening a test adds it and activates it", () => {
    const s = openTestTab(initialWorkspaceState(), "t1");
    expect(s.openTestIds).toEqual(["t1"]);
    expect(s.active).toBe("t1");
  });

  it("opening an already-open test does not duplicate, just activates", () => {
    let s = openTestTab(initialWorkspaceState(), "t1");
    s = openTestTab(s, "t2");
    s = openTestTab(s, "t1");
    expect(s.openTestIds).toEqual(["t1", "t2"]);
    expect(s.active).toBe("t1");
  });

  it("closing the active test activates its right neighbor, else left, else canvas", () => {
    let s = initialWorkspaceState();
    s = openTestTab(s, "t1");
    s = openTestTab(s, "t2");
    s = openTestTab(s, "t3");
    s = setActive(s, "t2");
    s = closeTestTab(s, "t2");
    expect(s.openTestIds).toEqual(["t1", "t3"]);
    expect(s.active).toBe("t3"); // right neighbor
    s = closeTestTab(s, "t3");
    expect(s.active).toBe("t1"); // left neighbor when no right
    s = closeTestTab(s, "t1");
    expect(s.active).toBe("canvas"); // nothing left
  });

  it("closing a non-active test keeps the active tab", () => {
    let s = openTestTab(initialWorkspaceState(), "t1");
    s = openTestTab(s, "t2");
    s = setActive(s, "t2");
    s = closeTestTab(s, "t1");
    expect(s.openTestIds).toEqual(["t2"]);
    expect(s.active).toBe("t2");
  });

  it("switching flow keeps open test tabs but returns to canvas", () => {
    let s = openTestTab(initialWorkspaceState(), "t1");
    s = openTestTab(s, "t2");
    s = switchFlow(s);
    expect(s.openTestIds).toEqual(["t1", "t2"]);
    expect(s.active).toBe("canvas");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- workspaceTabs`
Expected: FAIL — cannot find module `@/lib/workspaceTabs`.

- [ ] **Step 3: Implement `gui-lov/src/lib/workspaceTabs.ts`**

```ts
export type WorkspaceTab = "canvas" | string;

export interface WorkspaceState {
  openTestIds: string[];
  active: WorkspaceTab;
}

export function initialWorkspaceState(): WorkspaceState {
  return { openTestIds: [], active: "canvas" };
}

export function openTestTab(state: WorkspaceState, id: string): WorkspaceState {
  const openTestIds = state.openTestIds.includes(id)
    ? state.openTestIds
    : [...state.openTestIds, id];
  return { openTestIds, active: id };
}

export function setActive(state: WorkspaceState, tab: WorkspaceTab): WorkspaceState {
  return { ...state, active: tab };
}

export function switchFlow(state: WorkspaceState): WorkspaceState {
  return { ...state, active: "canvas" };
}

export function closeTestTab(state: WorkspaceState, id: string): WorkspaceState {
  const idx = state.openTestIds.indexOf(id);
  if (idx === -1) return state;
  const openTestIds = state.openTestIds.filter((t) => t !== id);

  let active = state.active;
  if (state.active === id) {
    if (openTestIds.length === 0) {
      active = "canvas";
    } else if (idx < openTestIds.length) {
      active = openTestIds[idx];        // right neighbor took this index
    } else {
      active = openTestIds[openTestIds.length - 1]; // was last → left neighbor
    }
  }
  return { openTestIds, active };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- workspaceTabs`
Expected: PASS — all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add gui-lov/src/lib/workspaceTabs.ts gui-lov/src/lib/workspaceTabs.test.ts
git commit -m "feat: add pure workspace-tab state module"
```

---

## Task 3: Density toggle hook (TDD)

**Files:**
- Create: `gui-lov/src/hooks/useDensity.ts`
- Test: `gui-lov/src/hooks/useDensity.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `useDensity(): { density: "compact" | "comfortable"; setDensity: (d) => void }`. Persists to `localStorage["sat.density"]`, default `"compact"`, and sets `data-density` on `document.documentElement`.

- [ ] **Step 1: Write failing test — `gui-lov/src/hooks/useDensity.test.tsx`**

```tsx
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- useDensity`
Expected: FAIL — cannot find module `@/hooks/useDensity`.

- [ ] **Step 3: Implement `gui-lov/src/hooks/useDensity.ts`**

```ts
import { useCallback, useEffect, useState } from "react";

export type Density = "compact" | "comfortable";
const KEY = "sat.density";

function read(): Density {
  const v = localStorage.getItem(KEY);
  return v === "comfortable" ? "comfortable" : "compact";
}

export function useDensity() {
  const [density, setDensityState] = useState<Density>(read);

  useEffect(() => {
    document.documentElement.setAttribute("data-density", density);
  }, [density]);

  const setDensity = useCallback((d: Density) => {
    localStorage.setItem(KEY, d);
    setDensityState(d);
  }, []);

  return { density, setDensity };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- useDensity`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add gui-lov/src/hooks/useDensity.ts gui-lov/src/hooks/useDensity.test.tsx
git commit -m "feat: add density toggle hook"
```

---

## Task 4: Density & typography tokens (CSS)

**Files:**
- Modify: `gui-lov/src/index.css`

**Interfaces:**
- Consumes: `data-density` attribute set by `useDensity` (Task 3).
- Produces: CSS custom properties `--rail-row-h`, `--rail-name-color`, and a 13px chrome base. Verified visually (pure CSS — no unit test).

- [ ] **Step 1: Add chrome base size + rail tokens**

In `gui-lov/src/index.css`, inside the existing `@layer base { :root { … } }` block (near `--radius`, around line 45), add:
```css
    /* Density + rail typography (Plan 1) */
    --rail-name-color: 180 5% 72%;   /* dimmed resting name text */
    --rail-row-h: 30px;              /* compact default */
```
Then after the `:root { … }` block, add density overrides and the chrome base:
```css
  :root[data-density="comfortable"] {
    --rail-row-h: 40px;
  }

  /* 13px chrome base; canvas/editor content sets its own sizes explicitly */
  html {
    font-size: 13px;
  }
}
```
Note: components that must stay at absolute sizes (code/JSON areas) already use explicit `text-sm`/`text-xs` utilities and are unaffected by shrinking the rem base only where relative units are used; verify visually in Step 2.

- [ ] **Step 2: Verify visually**

Run: `npm run dev`, open `http://localhost:8080`, open a project.
Expected: overall chrome is tighter; JSON payload/response text is still readable (not shrunk to unreadable). If code areas look too small, change their container to `text-[13px]`/`text-[14px]` explicit utilities rather than reverting the base.

- [ ] **Step 3: Commit**

```bash
git add gui-lov/src/index.css
git commit -m "feat: add density tokens and 13px chrome base"
```

---

## Task 5: Compact rows + name-anchored hover popover

**Files:**
- Create: `gui-lov/src/components/TestRowPopover.tsx`
- Test: `gui-lov/src/components/TestRowPopover.test.tsx`
- Modify: `gui-lov/src/components/TestInventory.tsx`
- Modify: `gui-lov/src/components/FlowsList.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `<TestRowPopover anchorRef={...} method={...} endpoint={...} description?={...} open={boolean} />` — a fixed-position popover anchored to the right edge of `anchorRef` (the name element), with a left-pointing arrow. Renders into `document.body` via a portal so it is never clipped by the rail's scroll container.

- [ ] **Step 1: Write failing test — `gui-lov/src/components/TestRowPopover.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { TestRowPopover } from "@/components/TestRowPopover";

describe("TestRowPopover", () => {
  it("renders method + endpoint when open", () => {
    const ref = createRef<HTMLSpanElement>();
    render(
      <>
        <span ref={ref}>Get Users</span>
        <TestRowPopover anchorRef={ref} method="GET" endpoint="/api/v1/users" open />
      </>
    );
    expect(screen.getByText("GET")).toBeInTheDocument();
    expect(screen.getByText("/api/v1/users")).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    const ref = createRef<HTMLSpanElement>();
    render(<TestRowPopover anchorRef={ref} method="GET" endpoint="/x" open={false} />);
    expect(screen.queryByText("/x")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- TestRowPopover`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement `gui-lov/src/components/TestRowPopover.tsx`**

```tsx
import { RefObject, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  anchorRef: RefObject<HTMLElement>;
  method: string;
  endpoint: string;
  description?: string;
  open: boolean;
}

export function TestRowPopover({ anchorRef, method, endpoint, description, open }: Props) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (open && anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect();
      setPos({ left: r.right + 12, top: r.top - 6 });
    } else {
      setPos(null);
    }
  }, [open, anchorRef]);

  if (!open || !pos) return null;

  return createPortal(
    <div
      role="tooltip"
      className="fixed z-50 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-lg
                 before:absolute before:-left-1.5 before:top-3 before:h-2.5 before:w-2.5 before:rotate-45
                 before:border-b before:border-l before:border-border before:bg-popover"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase text-muted-foreground">{method}</span>
        <span className="font-mono text-foreground">{endpoint}</span>
      </div>
      {description && <div className="mt-1 text-muted-foreground">{description}</div>}
    </div>,
    document.body
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- TestRowPopover`
Expected: PASS — 2 tests.

- [ ] **Step 5: Make `TestInventory` rows compact + wire the popover**

In `gui-lov/src/components/TestInventory.tsx`, replace the row markup (currently `TestInventory.tsx:212–271`, the two-line row with `px-3 py-2.5`) so each row is single-line, uses a name ref + hover state, and shows `TestRowPopover`. Add at top of the map body:
```tsx
// inside filteredTests.map((test) => { ... })
const nameRef = useRef<HTMLSpanElement>(null);
const [hovered, setHovered] = useState(false);
```
(Move these into a small `TestRow` subcomponent to keep hooks valid — extract the row into `function TestRow({ test, isSelected, onEdit, onDelete, onClick, onDoubleClick, getMethodColor }) {...}` within the same file, and render `<TestRow key={test.id} ... />`.)

Row JSX (single line; name is non-mono, weight 400, dimmed):
```tsx
<div
  draggable
  onMouseEnter={() => setHovered(true)}
  onMouseLeave={() => setHovered(false)}
  onClick={onClick}
  onDoubleClick={onDoubleClick}
  onDragStart={handleDragStart}
  className={`group flex items-center gap-2 h-[var(--rail-row-h)] px-2 rounded-md border cursor-pointer ${
    isSelected ? "bg-primary/10 border-primary/40" : "border-transparent hover:bg-muted"
  }`}
>
  <Badge variant="secondary" className={`text-[9px] px-1.5 py-0 ${getMethodColor(test.method)}`}>
    {test.method}
  </Badge>
  <span
    ref={nameRef}
    className="truncate text-[13px] font-normal"
    style={{ color: isSelected ? undefined : "hsl(var(--rail-name-color))" }}
  >
    {test.name}
  </span>
  {/* keep the existing MoreVertical dropdown here, unchanged */}
  <TestRowPopover
    anchorRef={nameRef}
    method={test.method}
    endpoint={test.endpoint || ""}
    open={hovered}
  />
</div>
```
Keep the existing `onDragStart` payload logic (`TestInventory.tsx:217–231`) as `handleDragStart`. Keep the existing dropdown menu (Edit/Delete). Remove `font-medium` and `font-mono` from the name; delete the old second-line endpoint `<div>`.

- [ ] **Step 6: Make `FlowsList` rows compact (drop bold)**

In `gui-lov/src/components/FlowsList.tsx:71`, change the flow name span from `text-sm font-medium text-sidebar-foreground` to `text-[13px] font-normal` with the dimmed color:
```tsx
<span className="flex-1 truncate text-[13px] font-normal"
      style={{ color: activeFlowId === group.id ? undefined : "hsl(var(--rail-name-color))" }}>
  {group.name}
</span>
```
Set the row container height to `h-[var(--rail-row-h)]` and remove the `mb-2` wrapper padding so rows are compact.

- [ ] **Step 7: Run tests + lint**

Run: `npm test && npm run lint`
Expected: PASS; no new lint errors.

- [ ] **Step 8: Verify visually**

Run: `npm run dev`; hover a test — popover appears just right of the name with an arrow, and rows below do not move. Names read as calm/dimmed.

- [ ] **Step 9: Commit**

```bash
git add gui-lov/src/components/TestRowPopover.tsx gui-lov/src/components/TestRowPopover.test.tsx gui-lov/src/components/TestInventory.tsx gui-lov/src/components/FlowsList.tsx
git commit -m "feat: compact single-line rail rows with name-anchored hover popover"
```

---

## Task 6: Stacked resizable rail (replace the Tests/Flows tab toggle)

**Files:**
- Modify: `gui-lov/src/pages/ProjectDetail.tsx:562–621`

**Interfaces:**
- Consumes: `TestInventory`, `FlowsList` (existing), `ResizablePanelGroup`/`ResizablePanel`/`ResizableHandle` (existing shadcn wrappers).
- Produces: a left panel that shows **both** Flows (top) and Tests (bottom) at once via a vertical `ResizablePanelGroup`. `sidebarTab` state and the `Tabs`/`TabsList`/`TabsTrigger` usage are removed from this file.

- [ ] **Step 1: Replace the left panel body**

In `ProjectDetail.tsx`, replace the entire left `<ResizablePanel defaultSize={35} …>` block (lines ~565–621) with a fixed-width stacked rail:
```tsx
<ResizablePanel defaultSize={22} minSize={17} maxSize={31} className="min-w-[220px] max-w-[400px]">
  <div className="h-full bg-sidebar border-r border-sidebar-border">
    <ResizablePanelGroup direction="vertical">
      <ResizablePanel defaultSize={40} minSize={15}>
        <FlowsList
          onAddGroup={handleCreateFlow}
          onEditGroup={(group) => {
            setEditingGroup({ id: group.id, name: group.name, description: group.description });
            setGroupDialogOpen(true);
          }}
          onDeleteGroup={async (flowId) => {
            if (!projectId) return;
            try {
              await deleteFlowMutation.mutateAsync({ id: flowId, projectId });
              deleteTestGroup(flowId);
              toast.success("Flow deleted");
            } catch (err) {
              toast.error("Failed to delete flow");
              console.error(err);
            }
          }}
        />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={60} minSize={20}>
        <TestInventory
          onAddTestCase={() => openTestCaseEditor()}
          onEditTestCase={(test) => openTestCaseEditor(test.id)}
          onDeleteTestCase={async (testCaseId) => {
            if (!projectId) return;
            try {
              await deleteTestCaseMutation.mutateAsync({ id: testCaseId, projectId });
              deleteTestCase(testCaseId);
              toast.success("Test case deleted");
            } catch (err) {
              toast.error("Failed to delete test case");
              console.error(err);
            }
          }}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  </div>
</ResizablePanel>
```

- [ ] **Step 2: Remove now-unused Tabs imports + sidebar state**

In `ProjectDetail.tsx`: remove the `Tabs, TabsContent, TabsList, TabsTrigger` import (line 31) and remove `sidebarTab`/`setSidebarTab` from the `useTestProject()` destructure (lines 62–63). The `openTestCaseEditor` used above already exists in this file (lines 100–108).

- [ ] **Step 3: Verify build + lint**

Run: `npm run lint && npm run build`
Expected: no unused-symbol errors for `Tabs`/`sidebarTab`; build succeeds.

- [ ] **Step 4: Verify visually**

Run: `npm run dev`. Flows and Tests are both visible in one column, split by a draggable divider; no Tests/Flows tab toggle remains.

- [ ] **Step 5: Commit**

```bash
git add gui-lov/src/pages/ProjectDetail.tsx
git commit -m "feat: stacked resizable rail replaces Tests/Flows tab toggle"
```

---

## Task 7: Tabbed workspace (pinned canvas + persistent test tabs)

**Files:**
- Create: `gui-lov/src/components/WorkspaceTabs.tsx`
- Test: `gui-lov/src/components/WorkspaceTabs.test.tsx`
- Modify: `gui-lov/src/contexts/TestProjectContext.tsx`
- Modify: `gui-lov/src/pages/ProjectDetail.tsx`

**Interfaces:**
- Consumes: `workspaceTabs` module (Task 2); `testGroups`/test-case names for tab labels.
- Produces on context (`TestProjectContextType`):
  - `workspace: WorkspaceState`
  - `openTestTab(id: string): void`
  - `closeTestTab(id: string): void`
  - `setActiveWorkspaceTab(tab: WorkspaceTab): void`
  - (existing `setActiveFlowId` is extended to call `switchFlow` internally.)
- Produces component: `<WorkspaceTabs tests={{id,name,method,dirty?}[]} />` rendering the pinned canvas tab + one closable tab per `openTestIds`.

- [ ] **Step 1: Add workspace state to context**

In `TestProjectContext.tsx`: import the module and wire state.
```tsx
import {
  WorkspaceState, WorkspaceTab, initialWorkspaceState,
  openTestTab as openTab, closeTestTab as closeTab, setActive, switchFlow,
} from "@/lib/workspaceTabs";
```
Add to `TestProjectContextType` (after `setActiveFlowId`, ~line 61):
```tsx
workspace: WorkspaceState;
openTestTab: (id: string) => void;
closeTestTab: (id: string) => void;
setActiveWorkspaceTab: (tab: WorkspaceTab) => void;
```
In the provider body, add state + handlers:
```tsx
const [workspace, setWorkspace] = useState<WorkspaceState>(initialWorkspaceState);
const openTestTab = useCallback((id: string) => setWorkspace((s) => openTab(s, id)), []);
const closeTestTab = useCallback((id: string) => setWorkspace((s) => closeTab(s, id)), []);
const setActiveWorkspaceTab = useCallback((tab: WorkspaceTab) => setWorkspace((s) => setActive(s, tab)), []);
```
Find the existing `setActiveFlowId` handler and, wherever it updates the active flow, also call `setWorkspace((s) => switchFlow(s))`. If `setActiveFlowId` is a plain state setter, wrap it:
```tsx
const setActiveFlowId = useCallback((id: string | null) => {
  setActiveFlowIdState(id);
  setWorkspace((s) => switchFlow(s));
}, []);
```
Add `workspace, openTestTab, closeTestTab, setActiveWorkspaceTab` to the context `value={{ … }}` object (near the other exports around line 779).

- [ ] **Step 2: Write failing test — `gui-lov/src/components/WorkspaceTabs.test.tsx`**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceTabs } from "@/components/WorkspaceTabs";

describe("WorkspaceTabs", () => {
  const tests = [{ id: "t1", name: "Get Users", method: "GET" }];

  it("always renders a pinned, non-closable canvas tab", () => {
    render(<WorkspaceTabs openTestIds={[]} active="canvas"
      tests={[]} onActivate={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/canvas|flow/i)).toBeInTheDocument();
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- WorkspaceTabs`
Expected: FAIL — cannot find module.

- [ ] **Step 4: Implement `gui-lov/src/components/WorkspaceTabs.tsx`**

```tsx
import { X } from "lucide-react";
import type { WorkspaceTab } from "@/lib/workspaceTabs";

interface TabInfo { id: string; name: string; method: string; dirty?: boolean; }

interface Props {
  openTestIds: string[];
  active: WorkspaceTab;
  tests: TabInfo[];
  onActivate: (tab: WorkspaceTab) => void;
  onClose: (id: string) => void;
}

export function WorkspaceTabs({ openTestIds, active, tests, onActivate, onClose }: Props) {
  const byId = (id: string) => tests.find((t) => t.id === id);
  return (
    <div className="flex items-end gap-0.5 border-b border-border bg-card px-2 pt-1.5">
      <button
        onClick={() => onActivate("canvas")}
        className={`rounded-t-md border border-b-0 px-3 py-1.5 text-xs ${
          active === "canvas" ? "bg-background text-foreground border-border" : "text-muted-foreground border-transparent"
        }`}
      >
        ◈ Flow
      </button>
      {openTestIds.map((id) => {
        const t = byId(id);
        return (
          <div
            key={id}
            className={`flex items-center gap-1.5 rounded-t-md border border-b-0 px-3 py-1.5 text-xs ${
              active === id ? "bg-background text-foreground border-border" : "text-muted-foreground border-transparent"
            }`}
          >
            <button onClick={() => onActivate(id)} className="flex items-center gap-1.5">
              <span className="text-[9px] font-bold uppercase text-muted-foreground">{t?.method}</span>
              {t?.name ?? id}
              {t?.dirty && <span className="h-1.5 w-1.5 rounded-full bg-warning" />}
            </button>
            <button aria-label={`close ${id}`} onClick={() => onClose(id)}
              className="opacity-60 hover:opacity-100">
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- WorkspaceTabs`
Expected: PASS — 2 tests.

- [ ] **Step 6: Render the workspace from tabs in `ProjectDetail.tsx`**

Replace the right `<ResizablePanel defaultSize={80}>` body (currently the `isEditing ? <TestCaseEditor…> : showConsole ? … : <TestCanvas/>` branch, lines ~626–654) with a tab-driven render. Pull the new context values into the `useTestProject()` destructure: `workspace, openTestTab, closeTestTab, setActiveWorkspaceTab`. Build the tab info from loaded test cases (reuse the `useTestCases` query already used by `TestInventory`; call it here too or lift it). Then:
```tsx
<ResizablePanel defaultSize={78}>
  <div className="flex h-full flex-col">
    <WorkspaceTabs
      openTestIds={workspace.openTestIds}
      active={workspace.active}
      tests={workspaceTabInfos}
      onActivate={setActiveWorkspaceTab}
      onClose={closeTestTab}
    />
    <div className="min-h-0 flex-1">
      {workspace.active === "canvas" ? (
        showConsole ? (
          <ResizablePanelGroup direction="vertical">
            <ResizablePanel defaultSize={65} minSize={30}><TestCanvas /></ResizablePanel>
            <ResizableHandle />
            <ResizablePanel defaultSize={35} minSize={20}>
              <ConsolePanel logs={consoleLogs} onClose={() => setShowConsole(false)} onClear={clearLogs} />
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <TestCanvas />
        )
      ) : (
        <TestCaseEditor
          key={workspace.active}
          testCaseId={workspace.active}
          onClose={() => closeTestTab(workspace.active as string)}
          onCreated={(newId) => { closeTestTab(workspace.active as string); openTestTab(newId); }}
        />
      )}
    </div>
  </div>
</ResizablePanel>
```
Where `workspaceTabInfos` maps open ids → `{ id, name, method }` from the test-case query results.

- [ ] **Step 7: Route open/close through tabs, not the full-screen swap**

In `ProjectDetail.tsx`, change `openTestCaseEditor` (lines 100–108) to open a tab instead of navigating to the full-screen route:
```tsx
const openTestCaseEditor = (testCaseId?: string) => {
  if (testCaseId) { openTestTab(testCaseId); }
  else { openTestTab("__new__"); }
};
```
Remove the `isEditing`/`testId`/`editingTestCaseId` full-screen branch and the `closeTestCaseEditor` navigation. Handle the `"__new__"` id in the render by passing `testCaseId={undefined}` to `TestCaseEditor` when `workspace.active === "__new__"`. Keep the `/project/:id/test/:testId` route working by, on mount, calling `openTestTab(testId)` if `testId` is present (so deep links still open a tab) — add a `useEffect` guarded on `testId`.

- [ ] **Step 8: Run tests, lint, build**

Run: `npm test && npm run lint && npm run build`
Expected: all pass.

- [ ] **Step 9: Verify visually**

Run: `npm run dev`. Double-click a test → opens a tab beside the pinned Flow tab; the canvas is still one click away; switching flows keeps the test tab open and returns to the canvas; closing the last test tab returns to canvas.

- [ ] **Step 10: Commit**

```bash
git add gui-lov/src/components/WorkspaceTabs.tsx gui-lov/src/components/WorkspaceTabs.test.tsx gui-lov/src/contexts/TestProjectContext.tsx gui-lov/src/pages/ProjectDetail.tsx
git commit -m "feat: tabbed workspace with pinned canvas and persistent test tabs"
```

---

## Task 8 (OPTIONAL / DISCUSS): Response as a collapsible right-side drawer

> **Discovered constraint:** The editor currently shows the response as an **internal tab** (`overview / request / scripts / response`, `TestCaseEditor.tsx:452–884`), not a side panel. The spec's non-goal says "no redesign of the editor's internal fields." Converting the Response tab into a right-docked drawer is a real internal-layout change. **Confirm with the requester before doing this task.** If deferred, the response simply stays as the existing tab — no loss of function.

**Files:**
- Modify: `gui-lov/src/components/TestCaseEditor.tsx`

**Interfaces:**
- Consumes: existing `executionResult` state and the current Response tab content (`TestCaseEditor.tsx:857–884`).
- Produces: a right-docked, slide-in/out drawer (~320px) showing the response; default open after a Send; a vertical "Response" handle to reopen when closed. The `request` tab content becomes the main column.

- [ ] **Step 1: Add drawer open state**

Near the other `useState` calls in `TestCaseEditor.tsx`:
```tsx
const [responseOpen, setResponseOpen] = useState(true);
```
On successful send (where `setActiveTab("response")` is called today, line 291), replace with `setResponseOpen(true)`.

- [ ] **Step 2: Remove the Response TabsTrigger, wrap response content in a drawer**

Delete the `<TabsTrigger value="response">` (lines ~468–471) and the `<TabsContent value="response">` wrapper (keep its inner response JSX). Wrap that inner JSX in a drawer positioned relative to the editor body:
```tsx
<div
  className={`absolute right-0 top-0 bottom-0 w-80 bg-sidebar border-l border-border
              flex flex-col transition-transform duration-200 ${responseOpen ? "translate-x-0" : "translate-x-full"}`}
>
  <div className="flex items-center justify-between px-3 py-2 border-b border-border text-xs uppercase text-muted-foreground">
    <span>Response</span>
    <button onClick={() => setResponseOpen(false)} aria-label="close response">✕</button>
  </div>
  <div className="flex-1 overflow-auto p-3">
    {/* existing response JSX moved here */}
  </div>
</div>
{!responseOpen && (
  <button onClick={() => setResponseOpen(true)}
    className="absolute right-0 top-3 [writing-mode:vertical-rl] rounded-l-md border border-r-0 border-primary/40 bg-primary/15 px-1.5 py-2 text-xs text-primary"
    aria-label="open response">
    Response
  </button>
)}
```
Make the editor body container `relative` and give the main tabs column `mr-80` when `responseOpen` so the drawer doesn't overlap.

- [ ] **Step 3: Lint + build + visual verify**

Run: `npm run lint && npm run build && npm run dev`
Expected: Send shows the response in a right drawer; the ✕ collapses it and the "Response" handle reopens it.

- [ ] **Step 4: Commit**

```bash
git add gui-lov/src/components/TestCaseEditor.tsx
git commit -m "feat: response as collapsible right-side drawer in test editor"
```

---

## Self-Review

- **Spec coverage (sections 1–6):** shell/header density (Task 4) ✓; stacked resizable rail (Task 6) ✓; tabbed workspace + pinned canvas + persistent tabs (Tasks 2, 7) ✓; console preserved (Task 7 render) ✓; routing via tabs (Task 7) ✓; density pass + typography + hover popover (Tasks 3, 4, 5) ✓; response drawer (Task 8, flagged) ✓. Groups/tags (section 7) intentionally out of this plan → Plans 2 & 3.
- **Placeholder scan:** none — every code step includes concrete code; the one judgment call (Task 8) is explicitly gated on requester confirmation, not a silent TODO.
- **Type consistency:** `WorkspaceState`/`WorkspaceTab` and `openTestTab`/`closeTestTab`/`setActive`/`switchFlow` are defined in Task 2 and consumed unchanged in Tasks 7. `useDensity`'s `data-density` (Task 3) matches the CSS selector in Task 4. `--rail-row-h`/`--rail-name-color` defined in Task 4 are consumed in Task 5/6.

## Follow-on Plans

- **Plan 2 — Test Groups** (`test_groups` table + `group_id` on `test_case`; grouped collapsible rail; group CRUD; drag-between-groups). Authored after Plan 1 lands so it builds on the realized `TestInventory` structure.
- **Plan 3 — Tags** (`tags` JSON column; tag chip filter bar; tag editor with autocomplete).
