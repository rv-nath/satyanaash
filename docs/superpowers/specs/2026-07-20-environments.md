# Environments & Globals — Design Spec

**Date:** 2026-07-20
**Scope:** mostly `gui-lov/` frontend; backend already supports the resolution
**Status:** design — pending review, then plan

## Problem

`baseUrl` (and other shared values) must be defined **once** and used by every
test via `{{baseUrl}}` — never re-declared per test. And the same variables need
**different values per environment** (dev / staging / prod) that a user can
switch between, like Postman. Today there are two competing `baseUrl` mechanisms
(a top "Base URL" prepend field and a `baseUrl` project variable) with confusing
precedence, and no notion of environments.

## Decisions (made)

- **Two layers: Globals + Environments** (full Postman-style model).
- **Active environment is per-user** (each teammate picks their own), stored
  client-side.

## Model

- **Globals** — variables shared across all environments (things that don't vary
  by env). This is what today's *Project Variables* become.
- **Environment** — a named set of variables (`dev`, `staging`, `prod`); each may
  define its own `baseUrl`, `authToken`, etc.
- **One active environment** at a time, chosen from a header dropdown.

## Resolution order

Extends the existing execution resolution. Highest priority first:

1. Execution vars (pre-test scripts / request overrides)
2. Context (exports from earlier test cases)
3. Node input vars → 4. Flow vars
5. **Active environment vars**
6. **Globals**
7. Built-ins (`$UUID`, `$Timestamp`, …)

So an environment value overrides a global of the same name; per-flow/node/request
still override the environment. `{{baseUrl}}` therefore resolves from the active
environment (falling back to a global if the env doesn't define it), and switching
environments flips it everywhere with **zero test edits**.

## Storage

- **Globals:** keep in `project.settings.variables` (the existing project-vars
  key) — relabelled "Globals" in the UI. No data migration needed.
- **Environments:** new `project.settings.environments` — an array of
  `{ id, name, variables: { [k]: string } }`. `project.settings` is already a
  free-form JSON blob updated via `PATCH /projects/:id`, so **no schema/table
  change**.
- **Active environment (per-user):** `localStorage["sat.activeEnv.<projectId>"]`
  = environment id (or `"none"`). Never sent to other users.

## Execution wiring (why the backend barely changes)

The execute handlers already do: `environment = project.settings.variables`
(globals) then overlay `request.environment` (request wins) — see
`executions.rs`. So the frontend simply sends the **active environment's
variables** as `request.environment` on execute; the backend merges them over the
globals automatically. Net backend change: **none** for resolution (only, later,
if we want server-side validation). Applies to flow run, flow debug/stream, and
single test-case execute — verify all three pass `environment` through.

## UI

- **Environment switcher** — a dropdown in the editor/canvas header (near Run):
  lists environments + "No environment"; selecting sets the per-user active env.
  Also a "Manage environments…" entry.
- **Manage Environments dialog** — replaces/extends the current Project Settings
  dialog:
  - A **Globals** section (the existing project-variable table, relabelled).
  - An **Environments** section: add/rename/delete environments; edit each one's
    variable table (name/value rows, same widget as globals).
- **Variable insight:** where `{{var}}` autocomplete/among "available variables"
  is shown, include globals + active-environment vars.

## baseUrl cleanup (the original pain)

- `baseUrl` becomes an ordinary variable — put it in each **environment** (dev vs
  staging differ) or in **Globals** if it never varies.
- The standalone top **"Base URL" prepend field** is the confusing duplicate.
  **Open decision (see below).**

## Decisions (resolved)

1. **Retire the top "Base URL" prepend field.** Remove it from Project Settings.
   On save, migrate: if `settings.baseUrl` has a value and Globals has no
   `baseUrl`, copy it into Globals as `baseUrl`, then drop `settings.baseUrl`.
   Endpoints use `{{baseUrl}}`. (The backend prepend logic can stay dormant —
   with no `settings.baseUrl`, `base_url` is `None` and nothing is prepended.)
2. **Environment definitions live at the project level; only the active
   selection is per-user** (localStorage). Confirmed.

## Non-goals (v1)

- No secrets/masked values, no import/export of environments, no bulk edit — just
  named var sets + a switcher.
- No server-side environment storage/validation (frontend-managed JSON is enough).

## Success criteria

- Define `baseUrl` once per environment; all tests use `{{baseUrl}}` unchanged.
- Switch environment from the header → next run hits the new host, no test edits.
- Globals shared across envs; env overrides a same-named global.
- No regression in existing variable interpolation, flow vars, or execution.
