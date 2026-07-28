# Satyanaash - Graph-based HTTP API Testing Framework

## Project Structure

- `api/` — Rust backend (Axum 0.8 + SQLx + Tokio)
- `gui-lov/` — React frontend (Vite + shadcn/ui + @xyflow/react)
- `docs/` — Design docs, requirements, API spec

## Build & Run

### Backend
```bash
cd api
cargo build
cargo test
cargo run          # Starts on http://127.0.0.1:3001
```

Environment variables (all optional with defaults):
- `DATABASE_URL` — default: `sqlite:satyanaash.db?mode=rwc`
- `BIND_HOST` — default: `127.0.0.1`
- `PORT` — default: `3001`
- `LOG_LEVEL` — default: `info`

### Frontend
```bash
cd gui-lov
npm install
npm run dev        # Starts on http://localhost:8080
```

## Architecture

### Backend (`api/`)
- **Framework:** Axum with Tower middleware (CORS, tracing)
- **Database:** SQLite via SQLx with raw SQL migrations in `api/migrations/`
- **Pattern:** Repository traits in `db/repositories/mod.rs`, implementations in separate files
- **Modules:**
  - `api/` — HTTP handlers (projects, flows, test_cases, executions);
    `POST /flows/{id}/clone` copies a flow's graph, keeping node ids (unique
    per flow) so aliases and node config survive
  - `db/` — Models and repository implementations
  - `execution/` — Test execution engine, Rhai scripting (assertions + pre-test scripts), SSE streaming
  - `validation/` — Graph structure validation
  - `error.rs` — AppError enum with automatic HTTP status mapping

### Frontend (`gui-lov/`)
- **Routing:** React Router v6
- **State:** TanStack Query for server state
- **Graph Editor:** @xyflow/react for flow visualization
- **UI:** shadcn/ui components with Tailwind CSS

## Key Concepts

- **Flows** contain a graph (nodes + edges) representing test execution order
- **Test Cases** define HTTP requests with BDD fields, headers, payload, exports, assertions
- **Exports** extract values from responses via JSONPath for chaining between test cases
- **Pre-test scripts** use Rhai with `SAT.vars.x = "value"` syntax (rewritten to `vars.x` internally); `SAT.env.x` persists into the active environment
- **Assertions** use Rhai scripts evaluated against response data
- **Generators** (`execution/generators.rs`) are registered on *both* script engines —
  `randomPhone()`, `uuid()`, `base64Encode(s)`, … — and mirror the `{{$Macros}}`.
  The GUI's pre-test snippets are pinned by a test there; they are Rhai, not JS
- **Script output** — `print()` / `debug()` are captured per run
  (`execution/script_log.rs`, a thread-local sink) into `NodeResult.logs`, not the
  server's stdout. It also maps JS habits (`console`, `typeof`, `null`, `JSON`) to
  advice appended to the Rhai error
- **Node alias** — `node.data.alias` names a node on the canvas, so two nodes can
  run one test case in different roles. The engine copies it to
  `NodeResult.node_label` and the `node_started` event; blank is treated as unset.
  Display rule lives in `nodeName()` (`hooks/useExecutionStream.ts`)
- **Node Expect** — `node.data.config.check` overrides the verdict for one node in
  one flow. Same two forms as a dataset row's Expect, through the same
  `parse_check`; when set, `assertion_script` does not run for that node. Verdict
  precedence in `run_once`: row Expect → node Expect → post-test script → 2xx
- **Datasets** run one test case against many bodies — see below
- **Project variables** stored in `project.settings.variables`, injected as environment into execution
- **Variable interpolation:** `{{variableName}}` in URLs, headers, payloads — resolved from execution context

## Variable Resolution Order (in execution)

Defined by `ExecutionContext::resolve` in `api/src/execution/variables.rs`.
**Lowest number wins** — the first tier that has the name is used.

1. `execution_vars` — one-off values passed in the execute request
2. `node_input_vars` — per-node overrides set on the flow canvas
3. `context` — exports from earlier test cases **and** `SAT.vars` set by scripts
4. `flow_vars` — variables scoped to a flow
5. `environment` — Globals + the active Environment merged client-side (env wins);
   `SAT.env` writes land here
6. Built-ins — `{{$UUID}}`, `{{$Timestamp}}`, `{{$RandomEmail}}`, … (see
   `generate_builtin`)

`resolve` delegates to `resolve_with_source`, so the order is stated once. In debug
mode each node logs `name ← tier = value` for every `{{name}}` in its endpoint,
headers and body (`ExecutionContext::provenance`) — the only way to see a value
that resolved from the environment when the run should have produced it.

A JSON **null is treated as absent** at every tier: it neither interpolates as the
text "null" nor shadows a real value further down. A value that is literally the
*string* `"null"` still resolves (it is a string), so `placeholder_values` reports
it in the run log — that case is a leftover in Globals, and it defeats the
unresolved-variable warning by resolving.

`node_input_vars` sits **above** `context` on purpose: it is what the author typed
on this node, while `context` is inherited from whatever ran earlier. Ranked the
other way, a node that set `my_email` explicitly still sent the value an earlier
step's pre-test script left behind. Don't swap them back.

There is deliberately **no data-row tier** — a dataset row overrides the body
wholesale rather than supplying variables (see below).

## Data-Driven Testing

A test case may carry a `dataset` — `{rows: [{id, name?, body?, check?}]}`, stored
as JSON on `test_cases.dataset`. Each row runs the request once.

There are **no named columns and no `data.*` namespace**: an earlier design had
both and it lost on usability — the author had to learn a template-variable model
before writing a single case. A row now overrides the *whole body*, which is
exactly what the author already knows how to write.

- **`body`** — replaces `test_case.payload` for that row (`resolve_body`); blank
  falls back to the payload. Interpolated either way, so `{{...}}` works in it.
- **`check`** — one column, two forms, told apart by `expected_status_code()`
  (all digits → shorthand):
  - all digits → status equality
  - anything else → a Rhai expression via `AssertionInput`, so it can also
    capture (`outcome.vars` / `outcome.env` are collected); a non-boolean result
    is reported as "must be a status code or an expression that is true or false"
    rather than a type error
  - blank → the built-in 2xx check
- **The shared `assertion_script` is never run for a row.** The two worlds are
  self-contained (see the comment at the `match row` in `run_once`): a script
  written for the single-request case can neither decide nor break a row's
  verdict. The pre-test script *does* run per row, and exports still run for a
  row that passed.
- **"Run request" ignores the dataset, and so does a flow node unless it opts in.**
  Rows iterate in exactly two places, both through `run_rows`: `all_rows: true` from
  the editor, and a node with `config.forEachRow`. `run_rows` clones the base context
  per row (so exports can't leak between rows), folds `SAT.env` writes forward, never
  aborts on a failure, and returns one aggregate `NodeResult` whose `iterations` holds
  the per-row results. **Sequential on purpose** — the `SAT.env` fold is
  order-dependent and the Rhai engines share a thread-local `print()` sink.
- **`DataRow.path`** is appended to the endpoint for that row (`resolve_endpoint`,
  sibling to `resolve_body`), composed *before* interpolation so the result is what
  `find_unresolved`, `placeholder_values` and `provenance` all see. A `?…` suffix joins
  an endpoint that already has a query with `&`.

## Running a dataset inside a flow (fan-out)

`node.data.config` gains `forEachRow` and `rowIds`. A marked node runs one request per
row against the **live** flow context, so every row inherits what earlier nodes
produced — which is the whole point: a dataset can now be used for a request that needs
a JWT.

- **An absent `rowIds` means every row.** Not `[]`, not a sentinel: absence is how this
  config already says "unset", and it means a row added later is included without
  anyone reopening the node. An **empty** list means none, and the node fails saying so.
- Results come out in **dataset order** whatever order they were selected in.
- **Verdict** is worst-of. A failed aggregate routes normally; an **errored** row makes
  the aggregate `Error`, which aborts traversal — a row that couldn't run at all is
  systemic. Teardown still runs. Don't demote it for fan-out only: the fold is shared
  with the editor path, and one loop would then have two verdict rules.
- **A fan-out node exports nothing** (`extra_exports: &[]`) because rows are isolated
  clones. Warned in the run log, in the panel, and by `FANOUT_DISCARDS_OUTPUT_VARS`.
- `ExecutionStats` counts **nodes, not rows** — a 20-row fan-out contributes one
  pass/fail, or `total` would mean two different things. The row count is on the
  console line instead.
- Expect cascade: **row's Expect → this node's Expect → post-test script → 2xx**. A
  check is **interpolated**, like the URL/headers/body, so a row can state the shape
  once (`response.json.items.len() == {{expected_count}}`) and each node supply the
  actor's value.
- `teardown_blocked` takes `extra_templates`, so a fan-out row's own body and path are
  guarded too — otherwise a row could aim a delete at a leftover id and slip past.

### Authoring patterns

| Situation | Mechanism |
|---|---|
| The answer is the same for everyone | a **literal** Expect on the row |
| Same request, answer depends on the actor (200 vs 403, 12 items vs 3) | a **variable** Expect, with the node supplying the value as an input variable |
| The case is meaningless for this actor (`402 no balance` on a funded account) | **untick the row** at that node |
- UI vocabulary, matching the buttons: **Run request** vs **Run dataset (N)**;
  columns are **Case | Body | Expect**.

### Gotchas

- `check` carries `alias = "expected_status"` to read rows saved before it was
  widened from a status code. Read-only: serializing writes `check` alone, so a row
  migrates itself on next save. Don't drop it — without it those rows load blank and
  pass on any 2xx, which is silent.
- `update()` in `test_cases.rs` is `input.x.or(existing.x)`, so the client must
  **always** send `dataset` or it can never be cleared.
- `row_to_test_case` must read `dataset` as `Option<String>` — the column is NULL
  for pre-migration rows.
- Interpolation is `\{\{(\$?[\w]+)…\}\}` — **no dots**, so `{{data.x}}` could
  never have worked.
- `DataRow.id` is `#[serde(default)]`, so rows created through the API or predating the
  editor can have `""` or duplicates. Selection by id can't address a blank one — the
  engine warns and the panel disables its checkbox. Most likely silent drop in the
  feature.
- A flow runs the **saved** dataset; the editor's unsaved-row override is editor-only.
- Flow **clone** keeps node config and shares test cases, so `rowIds` stay valid.

## Conventions
- Commit messages: `feat:`, `fix:`, `chore:` prefixes
- Backend tests: `cargo test` — unit tests inline in source files
- No ORM — raw SQL queries with SQLx
- Optimistic locking via `version` field on flows
