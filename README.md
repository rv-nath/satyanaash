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
- [Script variables](#script-variables)
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
- **Script variables** — pre/post-test scripts set `SAT.vars.x` (temporary, this
  run) or `SAT.env.x` (persisted to the active environment). (See below.)

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
value. Resolution walks these tiers **top-to-bottom and stops at the first match**:

| Priority | Tier | Where it comes from |
|:--:|------|---------------------|
| 1 | **Execution vars** | one-off values passed into a run |
| 2 | **Context** | exports from earlier test cases + `SAT.vars` from scripts (this run) |
| 3 | Node input vars | per-node overrides set on the flow canvas |
| 4 | Flow vars | variables scoped to a flow |
| 5 | **Environment** | active Environment layered over Globals (env wins); `SAT.env` writes land here |
| 6 | **Built-ins** | generated values (below) |

### Built-in variables

Generated on the fly — no setup needed. Write them with a `$` prefix:

| Macro | Produces | Arguments |
|-------|----------|-----------|
| `{{$RandomEmail}}` | a random email address | optional (e.g. a domain) |
| `{{$RandomName}}` | a person's name | — |
| `{{$RandomCompany}}` | a company name | — |
| `{{$RandomPhone}}` | a phone number | — |
| `{{$RandomAddress}}` | a postal address | — |
| `{{$RandomUsername}}` | `user_xxxxxxxx` | — |
| `{{$RandomInt}}` | a random integer | `{{$RandomInt(1000,9999)}}` → `min,max` |
| `{{$RandomString}}` | a random string | `{{$RandomString(12)}}` → length |
| `{{$RandomPassword}}` | a random password | `{{$RandomPassword(16)}}` → length |
| `{{$UUID}}` | a UUID v4 | — |
| `{{$Timestamp}}` `{{$TimestampMs}}` `{{$ISODate}}` | current time (secs / ms / RFC 3339) | — |

Example — dynamic signup payload:

```json
{
  "company": "{{$RandomCompany}}",
  "email":   "{{$RandomEmail}}",
  "mobile":  "9180{{$RandomInt(100000,999999)}}",
  "name":    "{{$RandomName}}"
}
```

> **⚠️ Each `{{$…}}` regenerates on every use.** Writing `{{$RandomEmail}}` in one
> request and again in another yields **two different emails**. If a later step
> needs the *same* value you generated, don't repeat the macro — **capture it once
> and reference it by name**:
>
> - **Generate it once in a script and reuse it.** In a pre-test script, use the
>   generator functions and store the result:
>   `SAT.vars.email = randomEmail();` — then reference `{{email}}` in the payload
>   and everywhere downstream. See [Script variables](#script-variables).
> - **From the response:** add an [Output variable](#exports--chaining-values)
>   (e.g. `signup_email ← $.email`) and use `{{signup_email}}` downstream.

---

## Pre-test scripts

A [Rhai](https://rhai.rs) script that runs **before** the request — use it to
prepare values. It cannot see the response (it hasn't happened yet).

```rhai
// Temporary — available as {{...}} for this run only, then gone
SAT.vars.mobile = randomPhone();
SAT.vars.email  = randomEmail();

// Persist into the active Environment (or Globals) — survives future runs
SAT.env.apiSecret = "ZXlvI14oYWZq";
```

See [Script variables](#script-variables) for `SAT.vars` vs `SAT.env` and the
generator functions (`randomPhone()`, `randomEmail()`, `randomInt(min,max)`, …).

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
// Persist a value into the environment, THEN assert
SAT.env.token = response.json.access_token;

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

> Side-effects (like `SAT.env.x = …`) apply **even if the assertion returns
> `false`** — matching Postman. A *script error* (bad syntax) applies nothing.

---

## Exports — chaining values

Exports declaratively pull values from a response using **JSONPath** and store them
in the flow context. You define them per node (Configure Node → **Output
variables**) or on the test case itself — each is a **name** plus a **JSONPath**:

| Export name | JSONPath |
|-------------|----------|
| `token` | `$.access_token` |
| `accountId` | `$.data.id` |
| `firstItem` | `$.items[0].id` |

Downstream nodes then reference the value by its **name** with the usual
interpolation syntax — same `{{ }}` you use everywhere else:

```
Authorization: Bearer {{token}}
GET {{baseUrl}}/accounts/{{accountId}}
```

Things to remember:

- **Reference the name, not the path** — `{{token}}`, never `{{$.access_token}}`.
- **Downstream only** — a value is available to nodes that run *after* the
  producer, following the flow's edges.
- **Only if the assertion passed** — if the producing node fails its check, the
  export doesn't run and `{{token}}` stays **literal** in the request (a handy
  debugging tell). JSONPath is rooted at the body with `$`; a path that matches
  nothing is skipped silently.
- **Scope is one flow run** — the context is fresh each run.

**Exports vs. scripts:** exports pull values from a **response**. To chain a value
you *generated* (a random mobile/email that the API never echoes back), set it in a
script instead — see below.

---

## Script variables

Pre-test and post-test scripts can set variables two ways:

| | `SAT.vars.x` | `SAT.env.x` |
|---|---|---|
| **Lifetime** | this execution only | persisted to the environment |
| **Within a flow run** | visible to all downstream nodes | visible to all downstream nodes |
| **After the run** | gone | stays in the active Environment (or Globals) |
| **Use it for** | chaining inside one flow run | keeping a value across separate runs |

`SAT.env.x` writes into the **active Environment** (or **Globals** when "No
environment" is selected) and is saved to the project — it *will* add variables to
your environment, by design.

### Generator functions

Scripts can call the same generators behind the `{{$…}}` macros:

```rhai
SAT.vars.mobile  = randomPhone();
SAT.vars.email   = randomEmail();          // or randomEmail("loadtest.com")
SAT.vars.company = randomCompany();
SAT.vars.otp     = randomInt(1000, 9999);
```

Available: `randomEmail()`, `randomPhone()`, `randomCompany()`, `randomName()`,
`randomUsername()`, `randomAddress()`, `randomInt(min,max)`, `randomString(len)`,
`randomPassword(len)`, `uuid()`, `timestamp()`, `timestampMs()`, `isoDate()`.

### Example — generate once, reuse everywhere (a flow)

In the **Sign up** node's pre-test script:

```rhai
SAT.vars.mobile = randomPhone();
SAT.vars.email  = randomEmail();
```

Then `{{mobile}}` / `{{email}}` resolve the same value in the signup payload **and**
in every downstream node (Set Password, Verify OTP) for that run.

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
| `POST` | `/test-cases/:id/execute` | run a single test case (accepts overrides + `environment`) |
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
