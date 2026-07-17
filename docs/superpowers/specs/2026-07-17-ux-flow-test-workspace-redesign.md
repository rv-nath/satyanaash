# UX Redesign — Flow / Test Workspace & Density

**Date:** 2026-07-17
**Scope:** `gui-lov/` frontend (React + Vite + shadcn/ui + @xyflow/react);
plus a small `api/` change for test grouping & tags (section 7)
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

- The workspace/density rework (sections 1–6) is purely `gui-lov/` presentation
  and client-side state/routing — no backend changes.
- **Test grouping & tags (section 7) is the one exception:** it requires a small
  backend change for persistence. It is scoped in deliberately (see section 7 and
  the Ngage rationale) rather than smuggled into the frontend-only work.
- No change to the test-case editor's *behavior* or field set. **Presentational
  humanization of the editor tabs is now in scope — see Section 8** (added after
  visual review). No graph node visual redesign beyond what density requires.
- No change to the Projects landing page.
- No nested/multi-level group hierarchy (single level only — see section 7).
- Tags are **not** a second organizational tree — they are a filter layer only.

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
- **TESTS:** searchable list, **organized into collapsible groups** with a
  **tag-filter chip bar** (see section 7); rows remain **draggable** onto the
  canvas (drag payload unchanged from `TestInventory.tsx:217`).
- Replaces the current `Tabs` toggle entirely — no more Tests/Flows tabs.

**Rail row treatment (validated in mockup):**

- **Name:** Inter (UI font, *not* monospace), weight **400**, resting color
  dimmed to ~**72% L** (`hsl(180 5% 72%)`); brightens to full / teal only on
  hover and active/selected. This kills the "everything looks bold / eye-grab"
  problem — the item stops competing for attention. Remove `font-medium` and
  `font-mono` from the name spans (`TestInventory.tsx:240`, `FlowsList.tsx:71`).
- **Method badge** (GET/POST/…): the sole persistent color accent per row.
- **Hover popover** (replaces inline two-line rows): a bordered popover that
  **anchors to the right of the test-name text** (not the row's right edge) with
  an arrow pointing back at the name. Contains method + endpoint (monospace) +
  short description + tag chips. Must render above the scroll container (portal /
  fixed positioning) so it never shifts rows below it. Monospace is reserved for
  the endpoint path here, where `{{var}}` legibility matters.

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
- **Response as a collapsible right-side drawer (validated in mockup):** inside a
  test-case tab, the request editor is the main column and the response is a
  drawer docked to the right that **slides in/out**. Default **open**; the header
  `×` collapses it (request editor expands to full width) and a vertical
  "Response" handle at the right edge slides it back. Width ~320px.

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

### 7. Test organization — groups & tags

**Rationale.** The target deployment (Ngage) has **50+ services** → potentially
hundreds of test cases. A flat list breaks down past ~30–40 items: it can't be
scanned, and search-only forces the user to already know the name. Organization is
a must-have at this scale, not a nice-to-have.

Two orthogonal mechanisms, each answering a different question — kept in their own
lanes:

- **Group = "where does this test live?"** — an organizational *home*. Exactly
  **one** group per test. Drives the sidebar tree.
- **Tag = "what is this test about?"** — cross-cutting attributes (`smoke`,
  `regression`, `p0`, `auth`, `wip`). **Many** per test. Drives *filtering only*,
  never a second tree.

This mirrors folders-vs-labels in Gmail/GitHub/Linear: one canonical home,
plus cross-cutting labels for filtering. Using tags as the primary organizer is
explicitly rejected — it removes the canonical location and makes a clean sidebar
tree impossible (the same test would appear under multiple branches, reading as
duplicates).

**Groups (v1 — build now):**

- **Single level, no nesting** (YAGNI; one group ≈ one service maps cleanly). May
  revisit nesting later if a service genuinely needs it.
- **User-created and dynamic**; a built-in **`Ungrouped`** catch-all always
  exists and can't be deleted.
- Rendered as **collapsible group headers** in the TESTS section: caret + name +
  count. Collapse all → just group names ("show only groups"). Collapsed state
  remembered per user (localStorage).
- **Drag a test between groups** to re-home it. New-group affordance in the TESTS
  section header.
- **Search spans all groups** and **auto-expands** groups containing matches, so
  grouping never fights findability.

**Group interactions (validated in mockup):**

- **Create a group:** a folder-plus icon in the TESTS section header (beside the
  new-test `+`) inserts an **inline "Untitled group" row** with the name field
  focused — type + Enter, no modal. Rename via double-click or the group's `⋮`;
  delete via `⋮` (its tests fall back to `Ungrouped`).
- **New groups are inserted at the TOP** of the tests list.
- **Assign a test to a group** — primary: a test row's `⋮` → **Move to group ▸**
  submenu (all groups, current one checked, + "New group…"). Secondary: a
  **Group field in the test-case editor**. Convenience: each group header has a
  hover `+` that creates a test already in that group (**create-in-place**).
  Drag-a-row-onto-a-group is deferred (avoids colliding with drag-to-canvas).
- **`Ungrouped`** always exists, can't be deleted, and is **hidden when empty**.

**Tags (v1.5 — fast-follow, designed-in now):**

- A **chip filter bar** above the grouped list. Selecting chips narrows the
  visible tests **across all groups** (grouped structure preserved; empty groups
  hide; matching groups auto-expand).
- Small **tag dots** on rows preview a test's tags at a glance.
- **Autocomplete from existing tags** when adding, to prevent sprawl
  (`smoke` vs `smoke-test` vs `Smoke`).
- Tags also power future "run all `smoke` across services" style selection.

**Data model / backend (the scoped-in change).** Two options considered:

| Approach | Effort | Trade-off |
|---|---|---|
| **A. `group` text column** on `test_case` | small (1 migration + field) | groups implicit (distinct values); rename = update N rows; empty groups can't persist |
| **B. `test_groups` table** + FK from `test_case` | medium | proper rename/reorder/empty-group persistence + group metadata |

**Decision: B** — grouping is core to the Ngage rollout, and rename /
reorder / empty-group persistence matter at that scale. Tags: a **`tags` JSON
array column** on `test_case` (same pattern as the existing `headers` JSON — no
join table needed for v1 filtering).

**Sequencing decision: groups first, tags as a fast-follow.** Ship the grouped
tree (with the tag chip bar built but hidden/no-op if needed) before wiring the
tag filter and editor. This lets the density + workspace + grouping win land
without waiting on tag UX.

Backend touch points: new migration (`00X_test_groups.sql` + `tags` column),
`db/models.rs` (`TestCase.group_id`, `TestCase.tags`), a `test_groups` repository,
and CRUD handlers under `api/test_cases.rs` / a new `api/groups.rs`.

### 8. Test-case editor humanization (added after visual review)

The editor tabs read as dense, jargon-heavy, and over-bold. Validated in the
companion mockup (Overview before/after). Apply one consistent "voice + calm"
recipe to **all four tabs**.

**Voice & guidance (from the user's `wizard-full.html` reference, adapted to the
dark theme):**
- Each tab opens with a **plain-English lead question** + a **one-line helper**
  that says what the section is for. No jargon nouns as headings.
- Field labels are plain English with a short helper each. Keep a **faint,
  lowercase technical hint** for pros (e.g. `given`/`when`/`then`, `HTTP`,
  `Rhai`) — recognizable, never shouting.
- Remove redundant/duplicate UI (e.g. the Overview "Preview" box that repeated
  the three inputs).

**Intensity hierarchy (dark theme), faint → strong:**
- Placeholder hints `hsl(180 5% 42%)` < helpers `hsl(180 5% 65%)` <
  field labels `hsl(180 5% 68%)` < lead question `hsl(180 5% 74%)`.
- One accent (primary/teal). Section-meaning color only as a **quiet left-edge
  stripe** (Overview given/when/then), not saturated pills.
- Content capped to a readable width; far fewer bold elements.

**Per-tab lead + label mapping:**

*Overview* — lead "What does this test check?" / helper "Describe the scenario in
plain words. Documents the test and shows in run reports; doesn't affect
execution." Fields: **Before — the setup** `given` / **Action — what happens**
`when` / **Expected result** `then`, each with a one-line helper; quiet colored
left-edge; **no Preview box**.

*Request* — lead "How is the request made?" / helper "The actual HTTP call this
test sends." Labels: **Method** `HTTP` · **URL** (helper: path to call, use
`{{variable}}`) · **Headers** (extra info sent with the request) · **Request
body** (the JSON sent) · **Variables you can use here** (insert; from earlier
steps).

*Scripts* — lead "Run code around the request?" / helper "Optional. Prepare
values before, or check the response after." Labels: **Before the request**
`Rhai` (set up values first) · **Check the response** `Rhai` (rules that decide
pass/fail). **Correct the mislabel:** current UI says "(JavaScript)" but the
engine is Rhai (`SAT.vars.x`) — fix the language reference.

*Response* — lead "What came back" / helper "The last run's result — status,
body, and headers." Read-only; calm the headings (Status / Body / Headers),
one accent for pass/fail.

**Non-goals for Section 8:** no change to fields, validation, execution, or the
Rhai/HTTP behavior — wording, hierarchy, and layout only.

## Success Criteria

- Flows list and Tests palette are both visible simultaneously without toggling.
- Editing a test case never hides the flow canvas; returning to the canvas is one
  click on its pinned tab.
- On a 1440px-wide laptop, the canvas is materially wider than today and the rail
  shows noticeably more items per screen.
- No regression in: dragging tests onto the canvas, autosave, validation,
  execution/console streaming, undo/redo.
- At 100+ test cases the rail stays usable: tests are grouped, groups collapse,
  and a tag filter narrows across groups without breaking the tree.
- Resting rail items read as a calm list (dimmed names, single color accent), not
  a wall of bold text.

## Open Questions

1. **Open test-case tabs on flow switch:** persist (recommended) vs. close with
   the flow. Current design assumes **persist**.
2. **Max open test tabs / overflow behavior:** do we cap open tabs or add a tab
   overflow menu? (Default: overflow menu, no hard cap.)
3. **Density toggle persistence:** per-user localStorage vs. project setting.
   (Default: localStorage, per-user.)
4. ~~**Group storage:** A vs. B.~~ **RESOLVED → B** (`test_groups` table).
5. **Group vs. flow relationship:** confirmed independent — a flow may pull tests
   from any group. (No open decision; noted to avoid conflation.)
6. ~~**Tags in v1 or v1.5.**~~ **RESOLVED → groups first, tags fast-follow**
   (designed-in now, tag filter/editor wired after groups land).

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

**Grouping & tags (section 7) — additional surface:**

- `src/components/TestInventory.tsx` — grouped, collapsible rendering; tag-filter
  chip bar; drag-between-groups; per-user collapsed-state.
- New: group CRUD UI (create/rename/delete group) and tag editor/autocomplete on
  the test-case editor.
- Backend: new migration (`test_groups` table + `tags` column on `test_case`),
  `api/src/db/models.rs` (`group_id`, `tags`), a `test_groups` repository under
  `api/src/db/repositories/`, and handlers (`api/src/api/test_cases.rs` and/or a
  new `api/src/api/groups.rs`).
- `src/lib/api/types.ts` / `src/hooks/useApi.ts` — group + tag types and queries.
