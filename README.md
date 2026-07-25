# Satyanaash

**A graph-based HTTP API testing framework** — build test cases like you would in
Postman, then wire them into visual *flows* that run end-to-end scenarios against
any environment.

Satyanaash pairs a Rust execution engine with a React canvas. You define HTTP
requests (with BDD documentation, variables, assertions, and scripts), connect
them on a graph, and run the whole thing — with variable interpolation, response
exports for chaining, and Rhai scripting throughout.

> **Note:** Earlier versions of Satyanaash were a Rust **CLI** that ran test cases
> from an Excel file. That tool now lives under [`legacy/`](legacy/) and the old
> docs under [`docs/README.md`](docs/README.md). This README covers the current
> full-stack app.

---

## Contents

- [Architecture](#architecture)
- [Getting started](#getting-started)
- [Core concepts](#core-concepts)
- [Writing a test case](#writing-a-test-case)
- [Variables & interpolation](#variables--interpolation)
- [Pre-test scripts](#pre-test-scripts)
- [Assertions (post-test)](#assertions-post-test)
- [Exports — chaining values](#exports--chaining-values)
- [Session variables](#session-variables)
- [Building a flow](#building-a-flow)
- [Environments & globals](#environments--globals)
- [API reference](#api-reference)
- [Development](#development)

---

## Architecture

| Part | Stack | Location |
|------|-------|----------|
| **Backend** | Rust · Axum 0.8 · SQLx · SQLite · Tokio | [`api/`](api/) |
| **Frontend** | React 18 · Vite · TypeScript · shadcn/ui · React Flow (`@xyflow/react`) · TanStack Query | [`gui-lov/`](gui-lov/) |
| **Docs / specs** | design docs, requirements | [`docs/`](docs/) |
| **Legacy CLI** | the original Excel-driven Rust CLI | [`legacy/`](legacy/) |

The engine traverses a flow graph, executes each test node's HTTP request,
interpolates `{{variables}}`, evaluates assertions, and passes exported values
downstream. Execution can stream progress over Server-Sent Events (SSE).

---

## Getting started

### Backend

```bash
cd api
cargo run          # starts http://127.0.0.1:3001
```

Configuration (all optional):

| Env var | Default |
|---------|---------|
| `DATABASE_URL` | `sqlite:satyanaash.db?mode=rwc` |
| `BIND_HOST` | `127.0.0.1` |
| `PORT` | `3001` |
| `LOG_LEVEL` | `info` |

### Frontend

```bash
cd gui-lov
npm install
npm run dev        # starts http://localhost:8080
```

Open the app, create a **Project**, and start adding test cases and flows.

---

## Core concepts

- **Project** — the top-level container. Holds test cases, flows, groups, globals,
  and environments.
- **Test case** — a single HTTP request plus everything needed to run and check it:
  method, endpoint, headers, payload, BDD documentation, exports, a pre-test
  script, and an assertion.
- **Flow** — a directed graph of nodes (`start → testCase/group … → end`) that
  defines execution order and pass/fail routing.
- **Group** — a labelled bundle of test cases (for organizing the inventory and
  running a set as one node).
- **Globals & Environments** — reusable variables. Globals are shared; an
  Environment (e.g. *Dev*, *Staging*) overrides globals when it's active.
- **Exports** — values pulled out of a response via JSONPath and made available to
  later test cases in a flow.
- **Session variables** — a disposable, per-project store that scripts can write to
  so you can chain standalone runs without a flow. (See below.)

---

## Writing a test case

A test case has four kinds of content: **documentation** (BDD), the **request**,
optional **scripts**, and **checks** (exports + assertion).

### BDD documentation (optional, non-functional)

Describes the scenario for run reports — it does not affect execution.

| Field | Meaning |
|-------|---------|
| **Given** | what must already be true |
| **When** | the action this test performs |
| **Then** | what a passing run looks like |

### The request

- **Method** — `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, …
- **Endpoint** — absolute (`https://api.example.com/v1/accounts`) or relative
  (`/v1/accounts`, joined to the environment's `baseUrl`).
- **Headers** — key/value pairs; values may contain `{{variables}}`.
- **Payload** — request body (typically JSON); may contain `{{variables}}`.

### Example — "Create account"

```
Method:   POST
Endpoint: {{baseUrl}}/v1/accounts

Headers:
  Content-Type:  application/json
  Authorization: Bearer {{token}}

Payload:
  {
    "profile": {
      "name": "{{$RandomName}}",
      "email": "{{$RandomEmail}}"
    }
  }

Assertion (post-test):
  response.status == 201 && response.json.id != ()

Exports:
  accountId  ->  $.id
```

Run it standalone from the editor's **Run Test**, or drop it into a flow.

---

## Variables & interpolation

Anywhere in a URL, header, or payload, `{{name}}` is replaced with a resolved
value. Resolution walks these tiers **top-to-bottom and stops at the first match**
(so tier 0 shadows everything):

| Priority | Tier | Where it comes from |
|:--:|------|---------------------|
| 0 | **Session** | `SAT.session.x` written by scripts (persists across standalone runs) |
| 1 | **Execution vars** | one-off values passed into a run |
| 2 | **Context** | exports from earlier test cases + `SAT.vars` from pre-test scripts |
| 3 | Node input vars | per-node overrides set on the flow canvas |
| 4 | Flow vars | variables scoped to a flow |
| 5 | **Environment** | active Environment layered over Globals (env wins) |
| 6 | **Built-ins** | generated values (below) |

### Built-in variables

Generated on the fly — no setup needed:

`{{$UUID}}` · `{{$Timestamp}}` · `{{$TimestampMs}}` · `{{$ISODate}}` ·
`{{$RandomEmail}}` · `{{$RandomInt}}` · `{{$RandomString}}` ·
`{{$RandomPassword}}` · `{{$RandomUsername}}` · `{{$RandomName}}` ·
`{{$RandomPhone}}` · `{{$RandomAddress}}` · `{{$RandomCompany}}`

Some accept arguments, e.g. `{{$RandomInt(1000, 9999)}}`.

---

## Pre-test scripts

A [Rhai](https://rhai.rs) script that runs **before** the request — use it to
prepare values. It cannot see the response (it hasn't happened yet).

```rhai
// This-run-only variables (tier 2) — gone after the run
SAT.vars.pageSize = 20;
SAT.vars.greeting = "hello " + "world";

// Persistent session variables (tier 0) — survive across standalone runs
SAT.session.lastActor = "smoke-test";
```

- `SAT.vars.x = …` → a **transient** variable, available as `{{x}}` in this run.
- `SAT.session.x = …` → a **session** variable (see below).

---

## Assertions (post-test)

A Rhai script that runs **after** the response and whose **last expression is the
pass/fail boolean**. It can also perform side-effects (like saving values) before
that final expression.

The `response` object exposes:

- `response.status` — HTTP status code (integer)
- `response.json` — parsed JSON body (`()` if not JSON)
- `response.body` — raw body string
- `response.headers` — response header map

```rhai
// Save a value for later runs, THEN assert
SAT.session.token = response.json.access_token;

// The final expression decides pass (true) / fail (false)
response.status == 200 && response.json.access_token != ()
```

More examples:

```rhai
response.status == 201                               // simple status check
response.json.items.len() == 3                       // array length
response.json.user.email.contains("@")               // string check
response.status == 200 && response.json.ok == true   // combined
```

> Side-effects (like `SAT.session.x = …`) apply **even if the assertion returns
> `false`** — matching Postman. A *script error* (bad syntax) applies nothing.

---

## Exports — chaining values

Exports declaratively pull values from a response using **JSONPath** and store them
in the flow context so later test cases can use them as `{{name}}`.

| Export name | JSONPath |
|-------------|----------|
| `token` | `$.access_token` |
| `accountId` | `$.data.id` |
| `firstItem` | `$.items[0].id` |

JSONPath is rooted at the response JSON body with `$`. A path that matches nothing
is skipped silently, and exports only run **if the assertion passed**.

**Exports vs. session:** exports are the mechanism for chaining **within a flow**.
Session variables (below) chain **standalone** runs.

---

## Session variables

A **Postman-style, disposable store** that scripts write to via `SAT.session.x`.
It's per-project, kept in the browser (localStorage), never saved into your project
config, and sits at the **top** of the resolution order — so a value you just set
always wins. Use it to run a series of standalone test cases and chain values
**without building a flow**.

```rhai
// In "Sign up" — post-test script
SAT.session.token = response.json.token;
response.status == 200
```

```
// In "Set password" — header, run standalone right after
Authorization: Bearer {{token}}
```

The header's **⚡ Session** indicator shows what's currently set; clear it any time.
`SAT.vars` = this run only; `SAT.session` = persists across runs until cleared.

---

## Building a flow

A flow is a graph you assemble on the canvas:

```
 ┌───────┐     ┌──────────────┐     ┌───────────────┐     ┌─────┐
 │ start │ ──▶ │ Sign up      │ ──▶ │ Set password  │ ──▶ │ end │
 └───────┘     │ (exports:    │     │ uses {{token}}│     └─────┘
               │  token)      │     └───────────────┘
               └──────────────┘
```

- **Nodes** — a `start`, one `end`, and any number of `testCase` / `group` nodes.
- **Edges** — connect nodes to define order. Edges carry an optional type that
  controls **conditional routing**:
  - `success` — followed when the source node **passed**
  - `failure` — followed when the source node **failed**
  - `default` (or untyped) — fallback when no matching typed edge exists

At each step the engine runs the node, then picks the next edge by the node's
result (pass → `success` edge, fail → `failure` edge, else `default`/any).

### Chaining in a flow

1. **Sign up** exports `token` (`$.token`) — the value enters the flow context.
2. An edge connects **Sign up → Set password**.
3. **Set password** references `{{token}}` in its `Authorization` header.

When you run the flow, `token` resolves from the context that Sign up produced.
Add a `failure` edge from Sign up to an error/cleanup node to handle the sad path.

### Running a flow

Run from the canvas. Progress streams live (per-node pass/fail, request/response,
logs) via SSE, and the final result reports totals plus the accumulated context.

---

## Environments & globals

- **Globals** live in the project and are always available (e.g. a default
  `baseUrl`).
- **Environments** (Dev, Staging, Prod…) hold variables that **override globals**
  when the environment is active. The active environment is per-user and shown in
  the header's **Env** switcher.

At run time, Globals and the active Environment are merged into one map (env wins)
and supplied as tier 5. Put shared values (`baseUrl`, keys) in Globals; put
per-stage overrides in an Environment.

---

## API reference

Base path: `http://127.0.0.1:3001/api/v1`

| Method | Path | Purpose |
|--------|------|---------|
| `GET/POST` | `/projects` | list / create projects |
| `GET/POST` | `/test-cases` | list / create test cases |
| `POST` | `/test-cases/:id/execute` | run a single test case (accepts overrides + `session`) |
| `GET/POST` | `/flows` | list / create flows |
| `POST` | `/flows/:id/execute` | run a flow (streams over SSE) |
| `GET/POST` | `/groups` | list / create groups |

---

## Development

```bash
# Backend
cd api
cargo build
cargo test          # unit tests live inline in the source

# Frontend
cd gui-lov
npm run build
npm test            # Vitest + Testing Library
npm run lint
```

**Conventions**

- Commit messages: `feat:` / `fix:` / `chore:` prefixes.
- Backend: raw SQL via SQLx (no ORM); repository traits in
  `api/src/db/repositories/`; migrations in `api/migrations/`.
- Flows use optimistic locking via a `version` field.

See [`CLAUDE.md`](CLAUDE.md) for a deeper architecture tour and
[`docs/`](docs/) for design specs.
