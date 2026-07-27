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
- [Data-driven testing](#data-driven-testing)
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
- **Dataset** — a table of input rows on a test case, run once per row, for
  covering many inputs (negative and edge cases) without building a flow.

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

Run it standalone from the editor's **Run request**, or drop it into a flow.
To run it against many bodies at once, see [Data-driven testing](#data-driven-testing).

---

## Variables & interpolation

Anywhere in a URL, header, or payload, `{{name}}` is replaced with a resolved
value. Resolution walks these tiers **top-to-bottom and stops at the first match**:

| Priority | Tier | Where it comes from |
|:--:|------|---------------------|
| 1 | **Data row** | the current row's cells in a data-driven run (see below) |
| 2 | **Execution vars** | one-off values passed into a run |
| 3 | **Context** | exports from earlier test cases + `SAT.vars` from scripts (this run) |
| 4 | Node input vars | per-node overrides set on the flow canvas |
| 5 | Flow vars | variables scoped to a flow |
| 6 | **Environment** | active Environment layered over Globals (env wins); `SAT.env` writes land here |
| 7 | **Built-ins** | generated values (below) |

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

### Printing from a script

Scripts are **Rhai, not JavaScript** — there is no `console`. Use `print(…)`, or
`debug(x)` to dump a whole value; both appear in that run's **log**, alongside the
engine's own messages. Output written before a script fails is kept, so a `print`
is a usable way to see what a check was looking at.

```rhai
print("status was " + response.status);
debug(response.json);                      // the parsed body, structure and all
response.status == 201
```

Other JavaScript habits and their Rhai spelling: `typeof x` → `type_of(x)`,
`null` / `undefined` → `()`, `JSON.parse` → nothing needed (`response.json` is
already parsed). The engine names these in the error when it recognises one.

---

## Data-driven testing

One request, many bodies. Covering an API's negative and edge cases doesn't need a
flow of near-identical nodes — give the test case a **dataset** in its **Data** tab
and the engine runs the request once per row.

| Column | Meaning |
|--------|---------|
| **Case** | Label for the row, shown in the results. Optional — blank rows read as *Row 1*, *Row 2*, … |
| **Body** | The body this row sends. Blank falls back to the Request tab's body. |
| **Expect** | What must be true for the row to pass. |

### Expect takes three forms

| You write | It means |
|-----------|----------|
| `400` | shorthand for `response.status == 400` |
| `response.json.error == "MISSING_FIELD"` | a Rhai expression, evaluated like an assertion |
| *(blank)* | any 2xx passes |

A check that is **nothing but digits** is the shorthand; anything else is a Rhai
expression against the same `response` object assertions use — so a row can check
fields and combinations, not just the status:

```rhai
response.status == 400 && response.json.errors.len() == 2
response.json.message.contains("company")
```

A row's check may capture on the way through, exactly like an assertion — the last
expression still decides pass/fail:

```rhai
SAT.env.token = response.json.access_token;
response.status == 201
```

### Example — SignUp negative cases

| Case | Body | Expect |
|------|------|--------|
| Empty payload | `{}` | `400` |
| Missing company | `{"email":"{{$RandomEmail}}","mobile":"{{$RandomPhone}}"}` | `400` |
| Blank company | `{"company":"","email":"{{$RandomEmail}}","mobile":"{{$RandomPhone}}"}` | `400` |
| Duplicate mobile | `{"company":"Acme","email":"{{$RandomEmail}}","mobile":"9180500001"}` | `409` |
| Valid | `{"company":"Acme","email":"{{$RandomEmail}}","mobile":"{{$RandomPhone}}"}` | `response.status == 201 && response.json.userId != ()` |

### Two ways to run

- **Run request** — runs the test case exactly as authored and **ignores the dataset
  entirely**. This is the primary test; nothing about it changes when you add rows.
- **Run dataset (N)** — runs once per row and returns a matrix: a line per row with
  its status, clickable to drill into that row's request and response.

Every row runs, pass or fail — the run doesn't stop at the first failure. The
overall verdict is the worst of the rows.

### What a row does and doesn't touch

- **The pre-test script runs for every row**, so `SAT.vars.mobile = randomPhone()`
  yields a fresh value per row.
- **Bodies are interpolated.** `{{baseUrl}}`, `{{$RandomEmail}}`, and anything a
  pre-test script or environment provides all work inside a row's body.
- **The post-test script is never run for a row.** A row's **Expect** stands alone,
  so an assertion written for the single-request case can neither decide nor break a
  row's verdict. (This is why an `{{...}}`-style capture in your assertion won't
  interfere with rows — it simply doesn't run.)
- **Exports still run** for a row that passed.
- **Rows are independent.** Each starts from the same context, so one row's exports
  can't leak into the next. `SAT.env` writes *do* carry forward — persisting is what
  they're for.
- **Flows ignore datasets.** A dataset-bearing test case inside a flow runs **once**,
  as authored — identical to how it behaved before datasets existed.

> A blank **Expect** means *any 2xx*, which is the right default for a happy-path row
> and the wrong one for a negative case: a row meant to check a rejection will
> **pass** on a 200. Give negative rows an explicit status.

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
  debugging tell). JSONPath is rooted at the body with `$`.
- **A path that matches nothing is reported**, naming the keys the body did have —
  `⚠ Export "my_jwt": nothing at $.accesss_token (body has: access_token,
  refresh_token)`. A typo here would otherwise only surface much later, as a
  literal `{{my_jwt}}` in a different request.
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

Available (arguments are optional — sensible defaults apply):
`randomEmail([domain])`, `randomPhone()`, `randomCompany()`, `randomName()`,
`randomUsername()`, `randomAddress()`, `randomInt([min, max])`,
`randomString([len])`, `randomPassword([len])`, `uuid()`, `timestamp()`,
`timestampMs()`, `isoDate()`.

Also available, and script-only (there's no `{{$…}}` macro for it):
`base64Encode(text)` — for building a Basic auth header.

```rhai
SAT.vars.authHeader = "Basic " + base64Encode(SAT.env.username + ":" + SAT.env.password);
```

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

- **Duplicating a flow** — most scenarios start as "the last one, with the tail
  changed". **Duplicate Flow** in a flow's ⋮ menu copies the whole graph, including
  each node's name, input variables and output variables, and opens the copy so you
  can edit from there. The original is untouched.
- **Nodes** — a `start`, one `end`, and any number of `testCase` / `group` nodes.
- **Input variables** — values set on a node in **Configure Node** win over
  anything an earlier step exported or a script set, for that node only. That's how
  two nodes running one request use different credentials.
- **Expect** — what must be true *at this point in this flow*. Blank means the test
  case's own assertion, as always; `402` is shorthand for
  `response.status == 402`; anything else is a Rhai expression. Use it when one
  request means different things in different scenarios — a send that should be
  **202** normally and **402** in a no-balance flow — rather than duplicating the
  request. When a node states an Expect, the test case's post-test script does not
  run for that node (same rule as a dataset row), so state what you need in the
  Expect itself; it may capture too. **Output variables are unaffected** and remain
  the flow-scoped way to carry values forward.
- **Naming a node** — a node shows its test case's name, but you can give it its
  own in **Configure Node → Node name**. Two nodes may run the same request in
  different roles — *Login as new user* and *Root login (for teardown)* — and the
  name is what tells them apart on the canvas and in the run log. The request it
  runs stays visible underneath. Pair it with **Input variables** on that node to
  give each role its own credentials.
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
