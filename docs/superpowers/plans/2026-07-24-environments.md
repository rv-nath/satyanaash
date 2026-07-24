# Environments & Globals Implementation Plan (Plan 4)

**Goal:** Postman-style Globals + switchable Environments, with a per-user active
environment; retire the standalone Base URL field.

**Architecture:** Frontend-only. Globals stay in `project.settings.variables`;
environments live in `project.settings.environments` (array). Active environment
is per-user in `localStorage`. On execute, the frontend sends the effective map
(globals overlaid with the active env, env winning) as the request `environment` —
the backend already merges that over globals, so no backend change.

**Spec:** `docs/superpowers/specs/2026-07-20-environments.md`.

## Global Constraints

- Globals = `settings.variables`; Environments = `settings.environments`
  (`[{ id, name, variables: {k:v} }]`); active env id in
  `localStorage["sat.activeEnv.<projectId>"]`.
- Resolution: env overrides global (send `{...globals, ...activeEnv}` on execute).
- Retire Base URL field: on settings save, if `settings.baseUrl` set and Globals
  lacks `baseUrl`, copy it into Globals; drop `settings.baseUrl`.
- `cd gui-lov && npm run build` green before each commit.

## Tasks

### T1 — `src/lib/environments.ts` (helpers)
- Types `EnvVars = Record<string,string>`, `Environment = { id; name; variables: EnvVars }`.
- `readGlobals(settings)`, `readEnvironments(settings)`.
- `activeEnvId(projectId)` / `setActiveEnvId(projectId, id|null)` (localStorage).
- `effectiveEnv(globals, environments, activeId)` → `{...globals, ...active?.variables}`.
- `genEnvId()` (uuid).
- Build gate + commit.

### T2 — Rework `ProjectSettingsDialog.tsx`
- Remove the Base URL field.
- Relabel "Project Variables" → "Globals".
- Add an **Environments** manager: list environments; add / rename / delete;
  per-env collapsible variable table (same row widget as globals).
- On save: serialize globals + environments; run the baseUrl migration; call
  `onSave(newSettings)`.
- Build gate + commit.

### T3 — Env switcher + execution wiring (`ProjectDetail.tsx`)
- Header dropdown near Run: lists environments + "No environment" + "Manage…".
  Selection persists via `setActiveEnvId`; shows active env name.
- `handleExecute` sends `environment: effectiveEnv(globals, environments, activeId)`.
- Build gate + commit.

## Self-review
- baseUrl once, per-env: ✓ (env var + effectiveEnv). Switch env → new host: ✓.
- Retire Base URL field + migrate: ✓ (T2). Per-user active: ✓ (localStorage).
- No backend change: relies on existing `settings.variables` + request env overlay.
