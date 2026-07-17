# UX Redesign — Flow / Test Workspace & Density

**Date:** 2026-07-17
**Scope:** `gui-lov/` frontend (React + Vite + shadcn/ui + @xyflow/react)
**Status:** Design approved; pending spec review before implementation planning

## Problem

The project already delivers its core value — building Postman-style test cases and
wiring them into flows — but the workspace UX gets in the way:

1. **Low information density.** The left sidebar is `35%`–`45%` of the screen
   (`ProjectDetail.tsx:565`) for two lists of names. List rows are two-line and
   airy (`TestInventory.tsx:232`, `px-3 py-2.5` ≈ 48px). Section headers consume
   ~160px of chrome before the first item. The canvas — the thing the user works
   in — is squeezed. The perception of "big fonts" comes mainly from spacing and
   an oversized fixed rail, not literal type sizes.

2. **The sidebar tab toggle conflates two different jobs.** The left panel toggles
   between **Tests** and **Flows** via `Tabs` (`ProjectDetail.tsx:567–619`). But
   *Flows* is navigation ("which scenario's canvas am I viewing") while *Tests* is
   a reusable palette you drag onto the canvas and the entry point to editing a
   test case. You cannot see both at once, so building a flow means constant tab
   ping-pong. Worse, editing a test case **replaces the entire canvas** with a
   full-screen editor (`ProjectDetail.tsx:627–636`), so the flow you were
   assembling disappears.

The underlying model has **three** first-class objects — **Flows** (scenarios),
**Test Cases** (reusable library), and the **Canvas/editor** (active workspace) —
but the UI collapses the first two into one tab-toggled column and lets the third
hijack the screen.

## Goals

- Make **flow-building** and **test-case authoring** equally first-class, with
  frictionless switching (user goal: "50/50").
- Never destroy the flow context when editing a test case.
- Increase the working surface (canvas + editor content) via a deliberate density
  pass, without shrinking the content users must actually read (JSON payloads,
  responses).

## Non-Goals

- No backend/API changes. This is purely `gui-lov/` presentation and
  client-side state/routing.
- No redesign of the test-case editor's internal fields or the graph node
  visuals beyond what density requires.
- No change to the Projects landing page.

## Design

### 1. Overall shell

```
┌───────────────────────────────────────────────────────────────┐
│ HEADER  ‹ Project / Flow ✎   [Run▾] ↶ ↷ ✓ ⤓          ⚙        │  slim
├──────────────┬────────────────────────────────────────────────┤
│ ▾ FLOWS      │ [◈ Login flow] [GET /users ×] [POST /login ×] + │  workspace tabs
│  ▸ Login  ●  │────────────────────────────────────────────────┤
│  ▸ Signup    │                                                 │
│  ▸ Checkout  │        ◯ ──→── ◯ ──→── ◯   (active tab body)    │
│ ┈┈┈drag┈┈┈┈  │                                                 │
│ ▾ TESTS   ⌕  │                                                 │
│  GET  /users │                                                 │
│  POST /login ├────────────────────────────────────────────────┤
│  PUT  /u/:id │ ▸ Console (collapsible)                         │
└──────────────┴────────────────────────────────────────────────┘
```

Three regions: slim header, stacked left rail, and a center **tabbed workspace**
with a collapsible console beneath it.

### 2. Left rail — stacked, resizable

- One column, two stacked sections: **FLOWS** (top) and **TESTS** (bottom),
  separated by a **draggable vertical divider** (reuse `ResizablePanelGroup`
  with `direction="vertical"` inside the left panel). Both always visible.
- Each section header is compact (~32px): title + item count + a single `+`
  icon-button, plus a collapse chevron so either section can be temporarily
  maximized.
- **FLOWS:** list of flows; the active flow shows a marker (● / left accent).
  Click selects/loads it into the pinned canvas tab.
- **TESTS:** searchable list; rows remain **draggable** onto the canvas
  (drag payload unchanged from `TestInventory.tsx:217`).
- Replaces the current `Tabs` toggle entirely — no more Tests/Flows tabs.

### 3. Center — tabbed workspace

- The **flow canvas is a pinned first tab** — always present, not closable.
- Opening a test case opens a **closable tab beside the canvas** instead of
  replacing it. Entry points: double-click a test in the rail, double-click a
  test node on the canvas, or the row's context menu → Edit.
- Switching flows in the rail swaps the **pinned canvas tab's** content.
- **Open test-case tabs persist across flow switches** (test cases are
  project-global building blocks, not flow-specific). *(Open question — see below.)*
- Unsaved-change indicator on a tab (dot) reusing the editor's existing dirty
  state.

### 4. Console

- Unchanged behavior — the existing collapsible bottom panel
  (`ConsolePanel.tsx`) docked under the workspace.

### 5. Routing / state

- Keep URL-driven state but represent **which workspace tab is active** rather
  than a full-screen editor mode. Roughly:
  `/project/:id?flow=<flowId>&tab=<canvas|testCaseId>` with a way to encode the
  set of open test tabs (e.g. session/local state, since the open-tab set is a
  workspace convenience rather than a shareable address).
- Remove the `isEditing`-swaps-the-whole-right-panel branch
  (`ProjectDetail.tsx:627`) in favor of tab selection.

### 6. Density pass

Compact is the **default**. A **Comfortable / Compact** toggle lives in Settings
for users who want more breathing room.

| Area | Today | Proposed (Compact default) |
|---|---|---|
| Left rail width | `35%` (max `45%`) | fixed **280px**, min 220, max 400 |
| Test/flow row | 2 lines, `py-2.5` (~48px) | **single line** (~30px): name + method badge; **endpoint & extra data shown on hover** (tooltip/expand) |
| Section header | `p-4` + `text-base` bold + subtitle + full-width button (~160px) | compact ~32px: title + count + `+` icon-button |
| App header | `py-3`, `text-lg` title | `py-2`, `text-sm/base`; name + description on one line |
| UI base type | browser default 16px | **13px** base for chrome; canvas/editor content unchanged |

Expected effect: ~15–25% more canvas width on a laptop, ~2× more rail items
before scrolling, and reclaimed vertical space — without shrinking the JSON
payload/response areas.

## Success Criteria

- Flows list and Tests palette are both visible simultaneously without toggling.
- Editing a test case never hides the flow canvas; returning to the canvas is one
  click on its pinned tab.
- On a 1440px-wide laptop, the canvas is materially wider than today and the rail
  shows noticeably more items per screen.
- No regression in: dragging tests onto the canvas, autosave, validation,
  execution/console streaming, undo/redo.

## Open Questions

1. **Open test-case tabs on flow switch:** persist (recommended) vs. close with
   the flow. Current design assumes **persist**.
2. **Max open test tabs / overflow behavior:** do we cap open tabs or add a tab
   overflow menu? (Default: overflow menu, no hard cap.)
3. **Density toggle persistence:** per-user localStorage vs. project setting.
   (Default: localStorage, per-user.)

## Affected Files (indicative, not a plan)

- `src/pages/ProjectDetail.tsx` — remove Tabs toggle + full-screen editor swap;
  introduce stacked rail + tabbed workspace; slim header.
- `src/components/TestInventory.tsx`, `src/components/FlowsList.tsx` — compact
  single-line rows, hover details, compact section headers; live together in the
  stacked rail.
- New: workspace tab-bar component + open-tabs state (likely in
  `TestProjectContext.tsx` or a new hook).
- `src/components/TestCaseEditor.tsx` — render inside a tab rather than
  full-screen; keep header/actions.
- `src/index.css` / `tailwind.config.ts` — density tokens, 13px chrome base,
  Comfortable/Compact theme switch.
- `src/contexts/TestProjectContext.tsx` — active-flow vs. open-test-tabs state;
  routing updates.
