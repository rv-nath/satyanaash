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
1. `execution_vars` (set by pre-test scripts)
2. `environment` (project variables + request overrides)
3. `context` (exports from previous test cases in flow)
4. Built-ins (`__timestamp`, `__uuid`, `__random_*`)

## Conventions
- Commit messages: `feat:`, `fix:`, `chore:` prefixes
- Backend tests: `cargo test` — unit tests inline in source files
- No ORM — raw SQL queries with SQLx
- Optimistic locking via `version` field on flows
