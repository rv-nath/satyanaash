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
- `HOOK_PORT` — default: `3002`. The callback receiver, bound `0.0.0.0` whatever `BIND_HOST`
  says, and write-only. See "Receiving a callback" below

### Frontend
```bash
cd gui-lov
npm install
npm run dev        # Starts on http://localhost:8081 (8080 is a krakend port-forward)
                   # PORT=9090 npm run dev, or npm run dev -- --port 9090, to move it
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
- **Execution state** lives in `TestProjectContext` (a hook owns it, the provider
  spreads it — same shape as `useAutoSave`/`useAutoValidate`), because the canvas
  decorates its nodes with it and each node's popover reports its own last run.
  `useExecutionStream` keeps `nodeRuns[flowId][nodeId]`; before that the console
  rendered each result into a line of text and dropped it
- **Saying something about a node** on the canvas has exactly one mechanism: a class
  on React Flow's wrapper (`styledNodes` in `TestCanvas.tsx`), matched by
  `.react-flow__node.X > div` in `index.css`. The `exec-*` rules sit **after** the
  `validation-*` ones — same specificity, so source order decides, and a run in
  progress outranks standing advice. The mapping is `executionClassFor`
  (`lib/executionDecor.ts`), kept pure so it can be tested without a graph
  - **Those rules must stay OUTSIDE `@layer`.** Tailwind purges rules inside an `@layer`
    directive whose class names it cannot find in its content scan, and every one of these is
    built at runtime (`exec-${state}`). `.exec-running` was literal nowhere, so it was stripped
    from the stylesheet and the "this node is running" pulse never rendered — for any node type,
    for as long as the rule existed. `exec-passed` / `exec-failed` / `exec-next` survived only
    because they are literal strings **in `executionDecor.test.ts`**, which sits inside the
    content glob: deleting those tests would have silently broken the decorations they test.
    Pinned now by a test in that file which parses `index.css` and fails if any
    `.react-flow__node.*` rule is inside a layer. A class list is not the thing to check — the
    class was always applied correctly; the stylesheet had no rule to match it

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
- **Polling** — `node.data.config.poll` makes a node ask again until its answer settles.
  Multi-stage uploads answer 202 with `{"status":"pending",…}` and the real outcome only
  exists after polling, so without this those tests assert on an answer that says only
  "I have your file". **Not a loop**: nothing iterates, one request is re-sent, so it is a
  property of the node — beside `check`, `teardown` and `forEachRow`. An **absent `until`
  means no polling**, which is every node that predates it (`poll_config`); `intervalMs`
  and `timeoutMs` default to `POLL_INTERVAL_MS` / `POLL_TIMEOUT_MS`, and a 0 is read as
  unset, not as a tight loop.
  - **`until` and `check` have distinct jobs.** `until` says the answer has settled;
    `check` says whether it was the right answer. Collapsing them lies: an upload whose
    status becomes `"failed"` would be retried to the budget and reported as "timed out",
    hiding the real result behind a slow one. `until` is interpolated like every other
    string, and refused at once — not waited out — if it isn't true-or-false.
  - **The loop wraps only the send.** The verdict cascade and exports run once, against
    the final response, or a pending attempt reports as a failure and exports fire per
    attempt. This is the delicate part of `run_once`.
  - Stopping rules, each so a wait cannot be mistaken for a result: a **4xx stops at
    once** (a 404 means the id is wrong and won't improve); **out of budget is `Failed`,
    never `Error`** — the request worked, the wait ran out — and it **short-circuits the
    cascade**, because a 202 satisfies the default 2xx check; **abandoned between
    attempts** via `RunOptions::unwatched()` plus the engine's stop flag, the same rule
    the node boundary applies, since a poll can hold a run open for minutes. Teardown
    still runs.
  - One log line per attempt with the polled values (`0/2 → 1/2 → 2/2`), and
    `NodeResult.attempts` so the report can say "3 attempts · 4.2s" — a single duration
    cannot tell one slow request from three quick ones and two waits. Absent when the node
    didn't poll, so nothing reports "1 attempt".
  - Warned before a run: `POLL_WITHOUT_UNTIL` (an interval with no condition turns polling
    off without removing it from the panel) and `POLL_BUDGET_BELOW_INTERVAL` (polling in
    name only). The frontend derives the attempt count in `lib/poll.ts` and shows the
    second one live, before saving.
  - Polling lives on the node, so the editor's own **"Run request" does not poll**.
    Test-case-level polling is the follow-up if that bites.
- **Stepping** — `run_flow` takes an optional `mpsc::Receiver<StepCommand>` beside
  `event_tx`: events out one per node, commands back one per node. `Stepper` holds
  it and parks the next node; `Next` buys one node, `RunToEnd` clears `pausing` for
  good, `Stop` abandons the traversal. **The first node goes without asking**
  (`Stepper::first`) — "Run step-by-step" should run something, not sit waiting.
  `execute_flow` is the thin no-stepping wrapper, which is why ~30 test call sites
  never had to change. The `paused` event names the node being waited on: which
  node is next depends on the last verdict and the teardown hop-over, so the canvas
  must not re-derive it
- **Teardown pauses but never abandons.** The teardown loop calls
  `pause_before_next` and *discards* the answer. There is no version of cancel that
  leaves the account behind — the same reason the loop is unconditional
- **A run nobody is watching stops** at the next node boundary
  (`RunState::client_gone`, i.e. `event_tx.is_closed()`), yielding status
  `"stopped"`. A run paused when the tab closes learns it through the `select!` on
  `tx.closed()` in `pause_before_next` — the boundary check can't help, that task
  is parked inside `wait`. Teardown still runs in both cases. Don't "fix" the
  bounded event channel by unbounding it: back-pressure is what keeps a stepped run
  honest
- **The step registry** (`StepRegistry` in `api/executions.rs`) holds one sender per
  pausable run, keyed by `execution_id`. Inserted **before** the task is spawned so
  a `Next` racing the first event has somewhere to land, and removed as the task's
  **last act** on every path — dropping the entry drops the sender, which is how a
  parked run learns nobody is left to press Next
- **`debug_mode` is always true from the UI.** The menu is Run / Run step-by-step;
  the old plain Run is gone. Provenance and per-node logs live behind the console's
  collapsible details, so there is no reason to make the author ask twice
- **Datasets** run one test case against many bodies — see below
- **Project variables** stored in `project.settings.variables`, injected as environment into execution
- **Variable interpolation:** `{{variableName}}` in URLs, headers, payloads — resolved from execution context

## Deep links

`/project/:id` and `/project/:id/test/:testId` are real routes, and `?flow=` / `?tab=` restore
canvas and sidebar state — so a link to a flow can be pasted or bookmarked.

**The main pane renders from `workspace.tabs`, not from `activeFlowId`**, and that is the whole
subtlety. `?flow=` used to restore the *selection* only, so a shared link arrived with the project
loaded — header, sidebar, everything — and an empty workspace showing the "Build a request" welcome
pane. It read as "deep routing is not supported" when the single missing act was opening the tab.
`/project/:id/test/:testId` had always called `openTestTab`; nothing did the equivalent for a flow.

The deep-link effect is guarded by a **ref, not by comparing against `activeFlowId`**. That guard
looks equivalent and is not: the "select the first flow" effect runs first, so when the linked flow
happened to *be* the first one the ids already matched and nothing opened — a link that worked or
did not depending on list order. Once per id, so closing the tab does not make it spring back,
while back/forward to a different `?flow=` still opens that one. A flow id that is not in the list
is ignored rather than opened empty: flows arrive after the first render, and a stale link is
quieter ignored.

## Variable Resolution Order (in execution)

Defined by `ExecutionContext::resolve` in `api/src/execution/variables.rs`.
**Lowest number wins** — the first tier that has the name is used.

1. `execution_vars` — one-off values passed in the execute request
2. `row_vars` — this data row's values for the request's own `{{names}}`
3. `node_input_vars` — per-node overrides set on the flow canvas
4. `context` — exports from earlier test cases **and** `SAT.vars` set by scripts
5. `flow_vars` — variables scoped to a flow
6. `environment` — Globals + the active Environment merged client-side (env wins);
   `SAT.env` writes land here
7. Built-ins — `{{$UUID}}`, `{{$Timestamp}}`, `{{$RandomEmail}}`, … (see
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

`row_vars` sits above `node_input_vars` for the same kind of reason, one level
finer: the node says what is true for the whole set (`expected_count`), the row says
what changes per iteration (`channel`). Set per row on that row's **own clone** of
the context, so one row's value cannot reach the next — `a_rows_value_beats_the_nodes_and_does_not_reach_the_next_row`
pins both halves. A blank value is not a value: it is filtered out so the name falls
through instead of sending an empty path segment.

## Data-Driven Testing

A test case may carry a `dataset` — `{rows: [{id, name?, body?, check?}]}`, stored
as JSON on `test_cases.dataset`. Each row runs the request once.

A row overrides the *whole body* rather than filling named body columns. An earlier
design had a `data.*` namespace and author-defined columns, and it lost on usability:
you had to learn a template-variable model and rewrite the payload as a template
before writing a single case.

**`DataRow.vars` is not that model coming back.** It holds values for the `{{names}}`
*the request already declares* — `/campaigns/{{channel}}/pause/{{campaignID}}` — and
the editor reads those names off the endpoint (`pathVariables` in `lib/dataset.ts`,
mirroring `template_names`). Nothing to define, nothing to learn: you named them when
you wrote the URL. The alternative was cutting the endpoint down to
`{{baseUrl}}/api/v1/campaigns` so rows could append the rest, which leaves the Request
tab describing a URL the test never sends. Bodies stay wholesale for the original
reason; only the URL's own placeholders get columns.

- Derived columns skip **built-ins** (`{{$UUID}}` is generated per use) and **a
  placeholder the endpoint starts with**, which is the base URL — every endpoint here
  begins `{{baseUrl}}/…` and a column for it in every dataset would be noise. A
  placeholder anywhere else is a parameter.
- Stored omitted-when-empty in a `BTreeMap`, so datasets written before it are
  untouched and a saved dataset's JSON doesn't churn on key order.

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
- **`DataRow.needs_flow`** marks a row the editor's run can't satisfy. `run_rows` reports
  it as `Skipped` without sending, but **only** when `RowRunOptions.honour_needs_flow` is
  set — true from `execute_test_case_dataset`, false from a flow node, because the flow is
  the precondition. It says *where* a row can run, not *why*: a missing JWT is one row's
  whole point and the next row's obstacle. Stored as the exception
  (`skip_serializing_if = "is_not_set"`), so datasets written before it are untouched.
  **A `Skipped` row is not a failure** — the fold counts only `Failed` and `Error`, so the
  aggregate stays `Passed`; four frontend sites had to be taught the same
  (`DatasetResultView`'s strip and status cell, `fanOutDetails`, `resultHeadline`).
- **`DataRow.disabled`** parks a row that isn't finished. Marked with a **⊘** in its own
  column, ghosted until hovered — nothing is drawn against a row that runs, because
  running is the norm and a column of ticks confirming it spends attention saying
  "normal". Amber rather than the ⛓'s red: parking is a choice, not a blockade. Skipped by `run_rows`
  **whatever the caller asked for** — that is the whole difference from `needs_flow`,
  which says *where* a row can run and is honoured only by the editor. Nothing revives a
  parked row, because "not ready" isn't a precondition anything can satisfy.
  Exists because a row half-written with `??` in its Expect was read as a Rhai
  expression, failed to parse, was classified `Error`, and aborted a seven-node flow. Two
  alternatives were weighed and rejected: a per-row "continue on error" flag (needs
  foresight about which row will break, and a typo is never foreseen — and an outcome you
  *can* predict you state as an expectation, so "expected error" has no meaning), and
  reclassifying an unparseable check as `Failed` (defensible, still open, but it changes
  verdict semantics project-wide to fix a half-written row).
- **Nothing ran is not a pass.** With every row skipped the fold used to yield `Passed`
  having sent nothing — the "worst kind of green" the empty-rows guard beside it warns
  about, reachable before parking existed by marking every row `needs_flow`. `run_rows`
  now returns `Skipped` with a message naming why, and `resultHeadline` says it in words:
  "0/0 rows passed" beside a ○ is a riddle. The skip note also counts —
  "(1 of 2 not run)" — because a bare "1/1 rows passed" beside a parked row reads as
  coverage it doesn't have, which is how a park becomes a way to hide a case from
  yourself. `iterations.is_empty()` still returns `Failed`: no rows *selected* is a
  misconfigured node, a different thing.
- `FANOUT_ALL_ROWS_DISABLED` warns on the canvas when every row a step would run is
  parked, alongside the other fan-out warnings.
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

## Collecting what each run produced, and walking it

A step that runs more than once **collects one record per run** into a list the author names
(`config.collect.into`), whose fields are that node's `outputVars`. A later step set to
`config.forEach = {list, as}` **runs once per element**, spreading a record's fields back out
as ordinary `{{names}}`.

Exists because a fan-out step used to hand forward **nothing**: `extra_exports: &[]`, an
aggregate hardcoding `exports: None`, and a warning saying so. Two campaigns launched from
two data rows left no way to call a status API for either one — the ids lived in per-row
context clones that were dropped at the end of each iteration.

- **A path of `$` is warned about in the panel** (`rootPathWarning`), because it is the one wrong
  path with no run-time warning at all: every other mistake produces "nothing at `$.foo` —
  `{{name}}` will not resolve", while `$` always matches and so always looks fine. What it does is
  store the *entire body* under one name, which cannot then be used — interpolation has no dots, so
  `{{campaign_info.campaignId}}` can never resolve and `{{campaign_info}}` pastes the whole JSON
  body into the request. That is exactly what one real flow did. `$..field` is left alone: it is a
  recursive-descent query and matches fields, not the root.
- **Records, not parallel arrays.** `campaignIds` and `txnIds` as two lists hold the pairing
  and *cannot express it*: the interpolation regex has no dots and no brackets, so the second
  run could never ask for **its** `txnId`. One record per run is what keeps a response's
  several useful fields together — which is the actual case, not one id per run.
- **Always a list of records**, even one row with one field. A shape that changed the day a
  second capture was added would break every step reading it at once.
- A field path takes the **first** match and says so. One run producing *several* records is
  deferred; the design it wants is an optional `each` naming the JSONPath whose every match
  is a record, with field paths read relative to each match.
- Only runs that **passed** contribute, and the log gives the tally
  (`Collected into "launched": 2 record(s) from 2 row(s)`) — a short list must be visible,
  not inferred. A path matching nothing **leaves its field out** rather than writing `null`,
  which would interpolate downstream as the four characters `null`.
- **`collect.when` is the bar; passing is only the floor.** A negative case expecting a 400
  *passes*, and no campaign was created — so "did the run pass" is the wrong question for whether
  it produced anything. Without a condition it works only by accident: whether a rejected launch
  contributes depends on whether the error body happens to carry a field with the same name as
  one being collected, which is an accident of the API's error shape rather than anything the
  author said. A Rhai expression against the response, interpolated like `check` and `until`;
  absent means "any run that passed", which is every step written before it. Neither-true-nor-
  false is a **broken condition, not a verdict**: nothing is collected, the reason is said once,
  and the step's own verdict is unchanged (the requests were fine) so the consuming step fails
  naming the missing variable rather than the tool guessing.
- **Collection notes are said once for the step, never per run** (`CollectTally`). The first
  attempt logged each miss where it happened and was unusable on the very dataset this exists
  for: nineteen rows, nine of them negative cases expecting a 400 and therefore holding no id at
  all. Two lines per such row is eighteen warnings about a run doing exactly what it was told,
  and a warning that is usually wrong is one nobody reads. So: one line naming the runs that
  produced no record, one per field genuinely missing from a record that *did* come back (the
  interesting case — something returned, incomplete), and one per multi-matching field, deduped.
  A row-scoped `[label] ` prefix on any collection complaint means the noise is back, and a test
  pins exactly that rather than counting one phrase.
- **Nothing collected → the variable is absent, not `[]`.** "No variable named launched" is
  something the consuming step can name and point at; `[]` reads as "the API returned
  nothing", a different bug with a different fix.
- Each record carries **`_row`**, the source row's label, used *only* to label the iteration
  that consumes it and never spread as a variable — so a failure reads "the 100-recipients
  campaign's status check failed", not "iteration 2 failed". The one reserved field name.
- The test case's **own `exports` still die per row**, keeping their existing warning. Node
  `outputVars` are about *this step in this flow*; test-case exports are about *this request*.
  That split is why one collects and the other cannot.
- **`RowPlan::Items` synthesises rows**, and shares the `match plan` arm with `Rows`. The
  loop, the verdict fold, the `SAT.env` fold, `iterations`, the child rows in `runs.rs` and
  all five frontend renderers are the dataset's — walking a list costs one substitution, not
  a second implementation of all of it. `plan_items` takes the context; `plan_rows` stays
  pure.
- Every way it can fail is `NothingSelected`, i.e. **`Failed` with a message**: no such
  variable (naming the step that should run first), not a list, empty (*nothing ran is not a
  pass*), plain values with no `as`, a list of lists, or both fan-out kinds at once. A field
  that renders **blank is skipped by name** — row vars filter blanks, so it would otherwise
  leave `{{campaignId}}` resolving from a *lower tier* and send a confidently wrong request.
- **An item that cannot fill the request is not sent**, and the dropped items are named once
  each, by the row that produced them. The request's `{{names}}` come from
  `variables::declared_names` over the endpoint, payload and header values, minus `$`-built-ins
  — those are generated per use, so counting them would make every item look unfillable and one
  `?nonce={{$UUID}}` would silently disable the feature. A name resolvable from the flow is not
  missing. **Blank was only half this guard**: a field *absent* from a record is not a blank
  value, so the blank check never saw it, and a real run sent
  `/campaigns/{{campaignId}}/status` — those fourteen literal characters — to a live API seven
  times. The engine warns about a literal placeholder and sends anyway, which is right for a
  request an author wrote and wrong here: the list wrote the iteration, and an item that cannot
  fill the request tests nothing. Every item unfillable → `NothingSelected`, i.e. `Failed`.
- **`NodeResult.iterations_of`** (`"item"`, absent for a dataset; migration 012) exists so no
  screen says "2/2 rows passed" about a step with no rows. Stored, not derived from the
  flow's current config — a flow can be edited after a run, and history must not be
  re-labelled by today's configuration. Frontend reads it through `iterationNoun`.
- Warnings: `FANOUT_COLLECTION_UNNAMED`, `FANOUT_COLLECTION_EMPTY`; errors
  `FOREACH_WITHOUT_LIST`, `FOREACH_AND_FANOUT`. `FANOUT_DISCARDS_OUTPUT_VARS` is **gone** —
  it described the opposite of what now happens. Whether the *list* exists is deliberately
  not checked server-side (only run time knows); the panel checks it against upstream
  collections, live, as a doubt rather than an error — a script or project variable can hold
  a list too.
- UI: one three-way toggle — **Once, as authored · Once per data row · Once per item in a
  list** — so "both kinds" is not expressible, rather than validated afterwards. `{{braces}}`
  are forgiven on the list name in the panel, the engine and the validator, so one config has
  one reading. `lib/nodeConfig.ts` holds the config type that used to be two inline casts.
- `getUpstreamCollections` (not `getUpstreamVariables`) finds the lists: output-variable
  names are a record's *fields*, so asking the wrong one suggests `campaignId` where the
  answer is `launched`.

## Receiving a callback, and waiting for one

Several test cases put a `drCallbackUrl` in their payload and expect that URL to be POSTed when
the message is delivered. Nothing could receive an inbound request, so those cases asserted on the
202 acknowledgement and stopped — the delivery, the thing under test, was checked by nothing.

Two halves: somewhere for the callback to land, and a step that waits for it.

### The receiver — its own listener, its own port

A second `axum::serve` in `main.rs` on `HOOK_PORT` (default **3002**), bound `0.0.0.0` whatever
`BIND_HOST` says, while the main API stays on loopback. Worth saying out loud, because
"satyanaash opens a port to the LAN" is a sentence someone should read before it surprises them.

- **Write-only on the exposed side.** `ANY /hooks/{*path}` records and always replies 200. Reading
  an inbox (`GET /api/v1/hooks[/{*path}]`) is on the **main** API only: a delivery report carries
  phone numbers, so the part anyone can reach must not hand them back. A GET on 3002 is a 404, and
  the smoke test checks it.
- **Any method, any body, any path, no pre-registration.** A delivery report is somebody else's
  contract; refusing a shape is refusing the test. The author mints paths client-side so the server
  cannot know them in advance, and refusing an unknown one would silently drop a real report —
  the one failure here that must not be quiet. Non-JSON is kept as text.
- **Bounded, because it is unauthenticated by construction**: 64 KB per body, 100 per path, 256
  paths, 60-minute TTL. Full is full — the *oldest* goes and the drop is **counted** (`dropped`),
  because an inbox that quietly forgot something is worse than one that says it is full. Expiry
  deliberately does **not** count towards it: "your inbox overflowed" and "an hour passed" are
  different facts, and only the first is actionable.
- **The cap covers `json` too**, which is the only reason it caps anything. The first version parsed
  the body *before* clipping it, so a 200 KB report kept a clipped `body` beside a complete parsed
  copy — a record contradicting itself, and a limit that saved nothing, the parsed form being the
  larger of the two. A clipped note now carries no `json` at all.
- **In memory, in one `Hooks` handle** threaded through `ExecutionState`, `executions.rs` (all
  three engine sites) and `SuiteRun`. A *second* `Hooks` would be a second set of inboxes and every
  wait would time out while the callbacks piled up in the one nobody was reading — which is why
  `ExecutionEngine::new` defaults to its own (each test gets an isolated set) and `with_hooks` is
  what the serving paths call.
- **Signalled by a `watch` counter, not a notification.** `Notify` had a lost-wakeup: `notified()`
  does not register the waiter until first polled, and `notify_waiters()` only wakes waiters already
  registered, so a callback landing between "read the inbox" and "await" was missed and the step sat
  out its whole timeout with the callback already in the inbox. A `watch::Receiver` remembers the
  version it has seen, which makes the race **unwritable** rather than fixed. Caught by its own
  test, before it was ever seen.

### The wait — a control node that reports a verdict

`node_type: "awaitCallback"`, a fifth branch beside `start`/`end`/`testCase`/`group`. **No test
case**: a node that sends nothing has no request to describe, and pointing it at one would leave
that test case's Request tab showing an endpoint nothing ever calls — the pattern already rejected
once for datasets. Unlike the other control nodes it *does* report a verdict, because "the delivery
report never came" is a test result and has to be able to be red.

Config is `config.awaitCallback = { path, count?, timeoutMs? }` beside `config.check` and
`config.outputVars`. It **shares the `"testCase"` dispatch arm** — the stats, the completed event,
the failure-edge routing and the final status are identical, and a second copy of that arm would be
a second place for the routing rules to drift.

**The callback becomes the step's `response`.** That is what makes this cheap: the Expect, the
output variables, the console's rendering and run-history persistence all key off `response` and
needed no teaching. The knowing misnomer is `status`, which is **what satyanaash replied** (200) and
never a status the caller sent — so the console *suppresses* it for a wait rather than relabelling
it, and calls the body **"Callback received"**. A row reading "Status 200" beside a report that said
`FAILED` is the one thing that must never appear.

- **Only callbacks that arrive after the run began count** (`RunState::started_at`). A path is a
  name the author chose and will reuse next week, so last week's report is still in that inbox and
  would satisfy today's assertion instantly. A `received_at >= run_start` filter (`since`), no
  clearing and no bookkeeping — and **nothing is armed per run**: the receiver records
  unconditionally from boot, so there is no pre-scan of the graph for paths and no listener to
  start. That falls out of accepting any path with no pre-registration.
  - **The step's own start was the first version, and it was wrong for the ordinary layout.** The
    step that provokes a callback is not the step that waits for it, and what sits between them
    takes time: a 19-row fan-out keeps sending for seconds after the row carrying the callback URL,
    so a delivery report arriving during rows 7–19 landed before the waiter started and was
    discarded — reported, correctly and uselessly, as "no callback arrived". The run is the right
    scope: it keeps the protection that matters while making the gap irrelevant, however many steps
    sit in it. The trade it accepts is an earlier step *in the same run* provoking a callback on the
    same path, and a rerun picking up a very late report from the previous attempt.
  - Pinned from both sides — `the_boundary_is_the_run_not_the_step` (mid-run counts, pre-run does
    not) and `a_whole_flow_counts_callbacks_from_when_the_run_began`, which goes through
    `execute_flow` because the unit tests pass their own boundary and could not see the wiring:
    with `started_at` set to the epoch every one of them still passed.
- **Nothing in the wait is periodic.** Every wake is a real event — an arrival, the deadline, the
  stream closing, a stop. An earlier version had a 250 ms cancellation sweep, which found arrivals
  on its own: that made the watch channel look optional, left the lost-wakeup bug untestable, and
  forced the latency test's bound tighter than the sweep, where it flaked.
- **Timing out is `Failed`, never `Error`.** Nothing broke; the callback did not come. `Error` aborts
  the flow and claims something systemic, hiding the rest of the run from an author whose only
  problem is a sender that has not implemented delivery reports yet.
- **A status-code Expect is refused, not honoured.** Against our own 200 it would pass whatever the
  callback said; against "the status the caller sent" it compares to something that does not exist.
  The message says to write an expression instead.
- **An unresolved path fails at once** rather than waiting out the timeout: a minute on an inbox
  literally called `dr/{{dr_path}}` then reporting "no callback arrived" names the wrong problem and
  sends the author to look at the sender.
- A wait can hold a run open for a minute, so **abandonment is honoured inside the node**: the
  stream's `closed()` and `shutdown::stop_requested()` are select arms, because a task parked in the
  wait cannot be reached by a boundary check — the same reason `pause_before_next` selects on
  `closed()`.
- `AWAIT_WITHOUT_PATH` is a validation **error**, so a wait with no path is reported before the run
  rather than sixty seconds into one. A flow of only await nodes is not `EMPTY_FLOW`.
- **`match` says which callback is this wait's own, and it is what makes several messages in
  flight testable.** Without it a wait takes the first `count` to arrive, which is fine for one
  message and the wrong question for five: the reports share an inbox and arrive in whatever order
  the network gives them, so "the next one" is not "mine". The correlation id goes in the callback
  URL's **query string** — `?cTxnId={{cTxnId}}` — and comes back verbatim, because the URL was
  ours to hand out; that needs nothing from the sender's payload contract. Matched with an
  ordinary interpolated expression (`response.query.cTxnId == "{{cTxnId}}"`), so one authored node
  serves every message.
  - `response.query` is **parsed** into a map for scripts (`parse_query` in `assertions.rs`, with
    a hand-rolled percent-decoder because this crate has no URL dependency), so a check reads a
    field instead of doing string surgery in Rhai. `()` for an ordinary HTTP response, which has
    no query — the same as a missing JSON key. The body is the fallback when a sender rebuilds the
    URL and drops the query: `response.json.clientTxnId == "{{cTxnId}}"`, identical machinery.
  - A **broken** match stops the step at once rather than being read as a non-match. Every
    candidate fails it identically, so waiting out the budget would only delay a report about a
    typo — and report it as "no callback arrived", which is a lie about the sender. Same refusal
    `until` and `collect.when` already make.
  - The timeout message distinguishes **"nothing came"** from **"nothing that was mine came"**
    (`N arrived on that path but none matched`). One message for both would send an author to
    look at the sender when the real fault is a correlation id that did not survive the round trip.
- **`forEach` on a wait runs one wait per expected report**, which is what turns "3 callbacks
  arrived" into "the 100-recipient message's report said FAILED". Each iteration gets a clone of
  the context carrying that item's fields, so the path and the match interpolate to *its* values,
  and each has its own verdict and its own `_row` label. Reported through the dataset's machinery
  — one aggregate whose `iterations` holds the per-item results, `iterations_of: "callback"` — so
  the console, run history and every renderer needed no teaching. `plan_items` now takes the
  **templates** a step interpolates rather than a `TestCase`, because a step that walks a list need
  not be a request at all; for a wait those are its path and its match, so "this item cannot fill
  it" means exactly that and an item with no correlation id is dropped by name rather than waiting
  out a full budget. The timeout is **per wait**, not shared: three missing reports cost three
  timeouts, the same rule polling follows — one budget across the set would make the last item's
  verdict depend on how slow the earlier ones were.
- `AWAIT_PATH_SHARED` warns when two steps wait on one inbox — **unless every one of them has a
  `match`**, which is the author saying which callback is theirs and therefore the answer to
  sharing an inbox rather than a symptom of one. Half-correlated is still a clash: the unmatched
  wait takes whatever arrives first, including the report the other was going to claim. **A wait filters the inbox, it does
  not consume from it** — nothing is removed or marked when one is satisfied — so two steps with a
  count of 1 each do not take one callback apiece: the second re-reads the same inbox and the same
  callback satisfies it at once. Both go green and the author believes they waited for two. A
  *warning*, because two steps asserting different things about the same report is a real thing to
  want. Compared as authored, not as resolved: two nodes holding `dr/{{dr_path}}` are the same
  inbox whatever it resolves to, and run time is the only place a resolved path exists.
- **`GraphValidator::validate` has a test harness now** (`NoRepos`), because until it did, nothing
  covered `validate` *calling* its rules — every test invoked a rule function directly, and deleting
  the `await_path_clashes` line from the validator left all 320 tests green. `poll_warnings`,
  `for_each_issues` and `fan_out_warnings` were all unwireable without a failure too. A rule nothing
  calls is a rule that does not exist.
- **One source of truth for the path.** A flow variable feeds both the payload's callback URL and
  the node's path (`{{hook_base}}/{{dr_path}}` and `dr/{{dr_path}}`), interpolated like every other
  field, so the two cannot drift. **`hook_base` is the author's own project variable, not config**:
  the address that reaches this machine depends on who is calling — a minikube pod sees
  `192.168.49.1`, a host on the LAN sees something else — so the server cannot know it, and a
  `HOOK_BASE` env var would be one setting that is right for one caller. **Stated limitation:** two concurrent runs sharing a path can take
  each other's callbacks; a variable in the path is the fix.
- **While it waits it spins and counts** (`2s / 60s`). The spinner is the **corner pip** every
  other node uses — `absolute -right-2 -top-2`, same size, same card-coloured ring — because
  "which node is going" must not be a different gesture per node type; an inline icon in the
  header row read as a different kind of node rather than as the same node running. Outside the
  flex row for the reason `TestCaseNode` already records: **nothing about a run may change a
  node's size**, or a column the author lined up comes out staggered the moment it runs. The count
  sits in a fixed-width slot for the same reason. The counting is the part no other node does,
  because no other node is slow enough to need it: over a minute a static ring answers neither
  "is this alive?" nor "how much longer?". The count is also what survives
  `prefers-reduced-motion` — the spinner stops, the number does not.
- **It emits `node_started`**, like a request node does from inside `execute_test_case_node`. Left
  out at first, and it is the one node type where the omission is worst: the canvas pulses the node
  it is told started, so a step that sits for a minute showed nothing at all and the run read as
  hung. The console branch is its own — "▶ Waiting for a callback: <name>", not "▶ Running" (it
  sends nothing) and not the generic "▶ Entering: awaitCallback node" (which named neither the step
  nor why the run appeared to stop). `handleEvent` is exported so each branch can be tested against
  a fake sink: `activeNodeId` is cleared when the stream closes, so "the node was marked active
  while it ran" is invisible from outside the hook.
- **The panel says one short line per field, with the long version behind an ⓘ.** The first
  version put the whole explanation under each field in 11px grey — three paragraphs of small print
  above the box you came to fill in, which reads as a wall and gets skipped, and a skipped
  explanation is the same as an unwritten one. The ⓘ appears only where there is more to say, so its
  presence means "there is depth here" rather than being furniture on every row. Labels earn their
  own keep too: **Path** became **Which inbox to watch** with a shown `/hooks/` prefix (a bare box
  labelled "path" gave no clue what it was the tail of), and **How many** became **Callbacks to
  wait for**, whose popover says the thing it kept being misread as — *it is not the number of
  messages you sent*.
- **A per-item wait with no list is an error, not a silent "once".** The panel used to write the
  `forEach` block only once a list had been typed, so the toggle could say "Once per item in a
  list" while the saved config said "once": the step waited for a single callback while the author
  believed it waited for one per message, and nothing warned because nothing could see the
  disagreement. The block is now written whenever the toggle is on, the mode is read back from the
  block's **presence** rather than from whether it names a list, and `await_errors` reports
  `FOREACH_WITHOUT_LIST` before the run. Found by an author's screenshot of the panel in exactly
  that state.
- Dropped onto the canvas from a new **Steps** palette in the left rail, which rides the
  `application/json` `{type, data}` channel the test-case and flow drags already use — so
  `handleDrop`, `addNodeToCanvas` and the undo history took it unchanged. Double-click opens its
  config, since there is no test tab behind it.

**Deferred:** handing *all* the callbacks to `iterations` so a `collect` could walk them (wants a
third iteration noun taught to the dataset renderers; the case in hand waits for one report);
persisting inboxes across restarts (a callback matters to a run in flight, and the one that matters
is already on the step's saved result); replying non-2xx to exercise a sender's retry logic.

## Conventions
- Commit messages: `feat:`, `fix:`, `chore:` prefixes
- Backend tests: `cargo test` — unit tests inline in source files
- No ORM — raw SQL queries with SQLx
- Optimistic locking via `version` field on flows
