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
  - `api/` — HTTP handlers (projects, flows, test_cases, executions)
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
- **Pre-test scripts** use Rhai with `SAT.vars.x = "value"` syntax (rewritten to `vars.x` internally)
- **Assertions** use Rhai scripts evaluated against response data
- **Project variables** stored in `project.settings.variables`, injected as environment into execution
- **Variable interpolation:** `{{variableName}}` in URLs, headers, payloads — resolved from execution context

## Variable Resolution Order (in execution)

Defined by `ExecutionContext::resolve` in `api/src/execution/variables.rs`.
**Lowest number wins** — the first tier that has the name is used.

1. `row_vars` — the current data-driven row's cells (empty for a normal run)
2. `execution_vars` — one-off values passed in the execute request
3. `context` — exports from earlier test cases **and** `SAT.vars` set by scripts
4. `node_input_vars` — per-node overrides set on the flow canvas
5. `flow_vars` — variables scoped to a flow
6. `environment` — Globals + the active Environment merged client-side (env wins);
   `SAT.env` writes land here
7. Built-ins — `{{$UUID}}`, `{{$Timestamp}}`, `{{$RandomEmail}}`, … (see
   `generate_builtin`)

## Data-Driven Testing

A test case may carry a `dataset` (`{columns, rows}`, stored as JSON on
`test_cases.dataset`). Each row supplies values for the columns and runs the
request once.

- A **column** is a variable name → usable as `{{column}}`; names must match
  `[A-Za-z_]\w*` or interpolation silently won't resolve them.
- Cells are interpolated, then JSON-coerced (`"400"` → number), so a shared
  assertion can compare `response.status == data.expected_status`.
- Scripts read the row as `data.<column>` (`SAT.data.` is rewritten to `data.`).
- Assertion per row: the row's own `assertion` → else the test case's
  `assertion_script` → else the built-in 2xx check.
- **Flows and a plain "Run Test" ignore the dataset entirely** — the test case as
  authored is the primary test. Only `all_rows: true` iterates
  (`execute_test_case_dataset`), returning one aggregate `NodeResult` whose
  `iterations` holds the per-row results.

## Conventions
- Commit messages: `feat:`, `fix:`, `chore:` prefixes
- Backend tests: `cargo test` — unit tests inline in source files
- No ORM — raw SQL queries with SQLx
- Optimistic locking via `version` field on flows
