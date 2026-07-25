# Session Variables — Design Spec

**Date:** 2026-07-25
**Status:** Approved design (pending user review of this doc)

## Goal

Let a test-case script (pre-test or post-test) **set variables that persist across
standalone test-case runs**, so a user can run a series of standalone tests for
quick verification and chain values between them — Postman-style — **without
building a flow**.

Concretely: run "Sign up" → its post-test script saves the returned `token` →
run "Set Password" standalone → it uses `{{token}}`.

## Non-goals

- Not durable project config. Session vars are **disposable**, never written to
  `project.settings` (Globals/Environments stay clean).
- Not cross-user or cross-browser. Session is per-browser, per-project.
- No new backend tables or backend-held session state. The backend stays
  **stateless** with respect to session vars.
- Not replacing Exports. Flow-based chaining via Exports (JSONPath) is unchanged.

## Concepts & hierarchy

Today's resolution order (`api/src/execution/variables.rs::resolve`, highest
priority first — **lowest number wins**):

| # | Tier | Notes |
|---|------|-------|
| 1 | execution_vars | one-off values in the execute request payload |
| 2 | context | exports + pre-test `SAT.vars` (transient, this run only) |
| 3 | node input vars | flow node overrides |
| 4 | flow vars | flow-scoped |
| 5 | environment | Globals + active Environment, flattened client-side (env wins) |
| 6 | built-ins | `$UUID`, `$Timestamp`, … |

**This spec adds a new tier 0 — `session` — at the very top.** A value a script
writes to the session store therefore shadows everything else, so a freshly-set
`token` always takes effect on the next run.

New resolution order: **session (0) → execution_vars (1) → context (2) → node
(3) → flow (4) → environment (5) → built-ins (6).**

`SAT.vars` vs `SAT.session` (both available in scripts):

- `SAT.vars.x` — **this-run-only** (tier 2). Cleared after the run. Existing behavior.
- `SAT.session.x` — **persists across runs** (tier 0, localStorage). New.

## Script API (property style)

Available in **both** the pre-test script and the post-test/assertion script.

**Write / delete:**
```rhai
SAT.session.authToken = response.json.token
SAT.session.userId    = response.json.data.id
SAT.session.baseId    = 42
SAT.session.remove("authToken")   // delete one
```

**Read:**
- In any request field (URL, headers, query, body): `{{authToken}}` — resolves
  against the full merged view (session → … → environment).
- In a script: `SAT.session.authToken` — returns the value, or `()` if unset.

**Mechanism (same trick as `SAT.vars`):** Rhai can't mutate a nested map in
place, so the engine seeds a **top-level mutable `session` map** into the script
scope and rewrites `SAT.session.` → `session.` before evaluation. After
evaluation it reads the `session` map back out.

## Post-test = one combined box (assertion + side-effects)

The post-test script stays a **single box** that already evaluates to a boolean
(`AssertionEngine` uses `eval_with_scope::<bool>`). In Rhai a block's value is
its **last expression**, so the user writes side-effects first, then a final
boolean:

```rhai
// side-effects
SAT.session.authToken = response.json.token
SAT.session.userId    = response.json.data.id

// last expression = pass/fail
response.status == 200 && response.json.token != ()
```

No new "assert function", no change to how pass/fail is judged.

**Side-effect-on-fail:** session writes happen *as the script runs*, so they
apply **even if the final assertion returns `false`** (the write already
happened before the boolean is known). This matches Postman
(`pm.environment.set` is not undone by a failing test). Documented, intended.

**Script error:** if the script throws (syntax/runtime), no session writes are
applied and the run is an `Error` (as today).

## Storage — client-side localStorage, backend stateless

- Key: `sat.session.<projectId>` → JSON object `{ name: <jsonValue> }`.
  (Mirrors the existing `sat.activeEnv.<projectId>` convention in
  `gui-lov/src/lib/environments.ts`.)
- The backend never stores session vars. Each execute request **carries** the
  current session map in; the response **carries the updated session map** back;
  the frontend persists it to localStorage.

### Data flow (standalone "Run Test")

1. Editor reads `sat.session.<projectId>` → `sessionVars`.
2. `POST /api/v1/test-cases/:id/execute` with body field `session: sessionVars`
   (alongside existing `variables`, overrides).
3. Backend builds `ExecutionContext` with the **session tier = sessionVars**
   (top), environment = project variables (as today).
4. Pre-test script runs (may read/write `SAT.session`). Request is interpolated
   (session available). Post-test/assertion runs (has `response`, may read/write
   `SAT.session`).
5. Backend returns `NodeResult` with a new field `session:
   Option<HashMap<String,Value>>` = the **full session map after writes**.
6. Editor persists the returned `session` back to `sat.session.<projectId>` and
   refreshes the header indicator.

### Flows

Flow execution uses the **same** `ExecutionContext`, so the session tier and the
`SAT.session` API work there too with **no extra design**: a flow run is seeded
with the same session store and returns the final session map, persisted on
completion the same way. (Wiring the flow execute request/response + SSE to
carry `session` is included; behavior is identical to standalone.)

## Backend changes

- **`ExecutionContext`** (`variables.rs`): add `session: HashMap<String, Value>`
  field; `resolve()` checks it **first**; add `new_with_session(...)` (or extend
  `new`), `set_session(name, value)`, `remove_session(name)`, and
  `take_session()`/`session()` accessor.
- **`PreTestScriptEngine`** (`pre_test_script.rs`): also seed a `session` map
  (from `ctx.session`), rewrite `SAT.session.` → `session.`, and return session
  writes in addition to `vars`. Return type becomes a small struct
  `{ vars, session }` (or two maps). Apply `vars` via `ctx.set` (tier 2),
  `session` via `ctx.set_session` (tier 0).
- **`AssertionEngine`** (`assertions.rs`): seed the `session` map into scope
  (for read + write), rewrite `SAT.session.` → `session.`, keep
  `eval_with_scope::<bool>` for the assertion result, then read the `session`
  map back. Return `AssertionOutcome { passed: bool, session: HashMap<...> }`
  instead of bare `bool`.
- **`engine.rs`**: thread session through `execute_test_case` (standalone) and
  the flow node path; after post-test, copy `ctx.session()` into
  `NodeResult.session`. Add `session: Option<HashMap<String,Value>>` to
  `NodeResult`.
- **`executions.rs`**: add `#[serde(default)] pub session: HashMap<String,Value>`
  to `ExecuteTestCaseRequest`; pass it into the engine.

## Frontend changes

- **`gui-lov/src/lib/session.ts`** (new): `readSession(projectId)`,
  `writeSession(projectId, map)`, `clearSession(projectId)`,
  `setSessionVar/removeSessionVar` helpers over `sat.session.<projectId>`.
- **`TestCaseEditor.tsx`**: `handleRunTest` sends `session: readSession(pid)` in
  the execute body; on result, `writeSession(pid, result.session)` and notify a
  session indicator to refresh.
- **`useApi.ts`**: extend `useExecuteTestCase` payload/response types with
  `session`.
- **Header indicator** (in `ProjectDetail.tsx`, near the Env dropdown): a
  `Session · N` button opening a popover that lists `name = value` rows and a
  **Clear session** action (wipes `sat.session.<projectId>`). Empty state:
  "No session variables yet — set them from a pre/post-test script." Optional
  per-row delete.
- **Session state**: hold the session map in `TestProjectContext` (seeded from
  localStorage on mount, keyed by project) so the indicator and the editor share
  one source of truth; persist on every change.

## Error handling

- Missing session key on read → empty map (no error).
- Script that references `SAT.session.x` where `x` is unset → `()` in Rhai
  (falsy), no error.
- Corrupt localStorage JSON → treat as empty, overwrite on next write (log to
  console).
- Backend receives no `session` field → `#[serde(default)]` → empty map.

## Testing

- **Backend unit** (`assertions.rs`, `pre_test_script.rs`): `SAT.session.x = v`
  is captured and returned; `SAT.session.remove` deletes; reading `SAT.session.x`
  returns the seeded value; assertion still returns the correct boolean while
  also emitting session writes; failing assertion still emits the writes.
- **Backend integration** (`engine.rs`): `execute_test_case` seeded with a
  session map resolves `{{x}}` from it (tier 0 beats environment); post-test
  write appears in `NodeResult.session`.
- **Frontend unit** (`lib/session.ts`): read/write/clear round-trip; per-project
  isolation; corrupt-JSON tolerance.
- **Manual**: run "Sign up" standalone (post-test sets `token`) → run
  "Set Password" standalone → `{{token}}` resolves; Clear session empties it;
  reload preserves it; a failing assertion still sets the var.

## Out of scope / future

- Editing session vars by hand in the popover (beyond delete/clear).
- A dedicated Exports editor in the standalone editor (separate gap, noted
  earlier).
- Persisting session into a real Environment ("promote to env") — possible later.
- Fixing the misleading `response.data.token` JSONPath placeholder in
  `NodeConfigPanel` (unrelated; track separately).
