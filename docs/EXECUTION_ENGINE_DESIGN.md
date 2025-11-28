# Satyanaash 2.0 - Execution Engine Design

> **Document Purpose**: Technical design specification for the Graph Execution Engine. Captures all design decisions made during planning for future reference.

> **Last Updated**: November 2025

---

## Table of Contents

1. [Overview](#overview)
2. [Design Decisions Summary](#design-decisions-summary)
3. [Architecture](#architecture)
4. [Edge Types & Routing](#edge-types--routing)
5. [Node Status Types](#node-status-types)
6. [Variable System](#variable-system)
7. [Assertion Engine (Rhai)](#assertion-engine-rhai)
8. [WebSocket Events](#websocket-events)
9. [API Endpoints](#api-endpoints)
10. [Database Schema](#database-schema)
11. [Use Cases](#use-cases)
12. [Error Handling](#error-handling)
13. [Graph Validation](#graph-validation)

---

## Overview

The Execution Engine is responsible for traversing a graph-based test flow and executing HTTP API test cases at each node. It supports:

- **Async execution**: Returns immediately with an execution ID
- **Real-time updates**: WebSocket for live node completion events
- **Branching flows**: Success/failure routing based on test results
- **Variable passing**: Context propagation between test cases
- **Declarative assertions**: Rhai scripting for response validation

---

## Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Script Engine** | Rhai | Rust-native, fast, no external runtime (vs V8/deno_core) |
| **Result Delivery** | WebSocket | Real-time node updates for UI responsiveness |
| **Execution Mode** | Async | POST returns ID immediately; runs in background via `tokio::spawn` |
| **Edge Types** | 3 types: `default`, `success`, `failure` | Simple model; "always" edge deemed unnecessary |
| **Missing Edge** | Stop execution | If test fails and no failure edge exists → stop |
| **Error Handling** | Stop immediately | Network/syntax errors stop execution (vs following failure edge) |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         API Layer                                │
├─────────────────────────────────────────────────────────────────┤
│  POST /flows/{id}/execute  →  Returns execution_id immediately  │
│  GET  /executions/{id}     →  Poll execution status/results     │
│  WS   /executions/{id}/ws  →  Real-time node completion events  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Execution Manager                            │
├─────────────────────────────────────────────────────────────────┤
│  • Spawns execution tasks (tokio::spawn)                        │
│  • Manages WebSocket connections per execution                   │
│  • Broadcasts node completion events                             │
│  • Handles cancellation requests                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Execution Engine                             │
├─────────────────────────────────────────────────────────────────┤
│  • Graph traversal (start → success/failure routing → end)      │
│  • Node execution dispatcher                                     │
│  • Context management (variables across nodes)                   │
│  • Result collection                                             │
└─────────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  HTTP Executor  │ │ Variable System │ │ Assertion Engine│
├─────────────────┤ ├─────────────────┤ ├─────────────────┤
│ • reqwest client│ │ • Interpolation │ │ • Rhai runtime  │
│ • Request build │ │ • JSONPath ext  │ │ • response obj  │
│ • Response cap  │ │ • Context merge │ │ • Boolean eval  │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

### Components

| Component | File | Responsibility |
|-----------|------|----------------|
| Execution Manager | `execution/manager.rs` | Spawns tasks, manages WebSocket, handles cancellation |
| Execution Engine | `execution/engine.rs` | Graph traversal, node dispatch, result collection |
| HTTP Executor | `execution/http.rs` | Build and send HTTP requests, capture responses |
| Variable System | `execution/variables.rs` | Interpolation, JSONPath extraction, context |
| Assertion Engine | `execution/assertions.rs` | Rhai runtime, response object, boolean evaluation |

---

## Edge Types & Routing

### Three Edge Types

| Type | When Used | UI Color | Description |
|------|-----------|----------|-------------|
| `default` | Unconditional | Gray | Used by START node; also fallback when only one edge |
| `success` | Test passed | Green | Follow when assertion returns `true` |
| `failure` | Test failed | Red | Follow when assertion returns `false` |

### Routing Rules

```rust
impl ExecutionGraph {
    fn get_next_node(&self, current_id: &str, status: NodeStatus) -> Option<&GraphNode> {
        match status {
            NodeStatus::Passed => {
                // Try success edge, fall back to default
                self.edges.get(&(current_id.to_string(), EdgeType::Success))
                    .or_else(|| self.edges.get(&(current_id.to_string(), EdgeType::Default)))
                    .and_then(|target_id| self.nodes.get(target_id))
            }
            NodeStatus::Failed => {
                // ONLY follow failure edge. No edge = stop.
                self.edges.get(&(current_id.to_string(), EdgeType::Failure))
                    .and_then(|target_id| self.nodes.get(target_id))
            }
            NodeStatus::Error | NodeStatus::Skipped => {
                // Error = stop immediately
                None
            }
        }
    }
}
```

### Key Routing Behaviors

| Scenario | Behavior |
|----------|----------|
| Test passes, success edge exists | Follow success edge |
| Test passes, no success edge, default exists | Follow default edge |
| Test passes, no edges | Stop execution |
| Test fails, failure edge exists | Follow failure edge |
| Test fails, no failure edge | **Stop execution** |
| Error occurs (network, timeout) | **Stop immediately** |

### Why No "Always" Edge?

During design, we considered an "always" edge type that would execute regardless of pass/fail. Decision: **Not needed** because:

1. `default` edge serves the unconditional case for START node
2. If you need to always execute something, create both success and failure edges to it
3. Keeps the model simple with clear semantics

---

## Node Status Types

| Status | Meaning | Routing |
|--------|---------|---------|
| `passed` | Test executed successfully, assertion returned `true` | Follow success/default edge |
| `failed` | Test executed, assertion returned `false` | Follow failure edge (or stop) |
| `error` | Test couldn't execute (network error, timeout, syntax error) | **Stop immediately** |
| `skipped` | Node was not reached during execution | N/A |

### Error vs Failed

This distinction is important:

| Type | Description | Example | Routing |
|------|-------------|---------|---------|
| **Failed** | Test ran and assertion was false | Status 401 when expected 200 | Follow failure edge |
| **Error** | Test couldn't run at all | DNS resolution failed, timeout | Stop immediately |

**Rationale**: Errors are unexpected system issues. The user should investigate before proceeding. Failed tests are expected outcomes that can be handled in the flow.

---

## Variable System

### Variable Types

| Type | Source | Example | When Resolved |
|------|--------|---------|---------------|
| **Execution vars** | POST /execute body | `baseUrl`, `apiKey` | Before execution |
| **Environment vars** | Project settings | `dev.baseUrl`, `staging.apiKey` | Before execution |
| **Context vars** | Exports from previous TCs | `token`, `userId` | During execution |
| **Built-in vars** | System-generated | `$UUID`, `$Timestamp` | At substitution time |

### Resolution Order (Highest Priority First)

```
1. execution_vars  →  Variables passed in POST /execute request
2. environment     →  From project settings (selected environment)
3. context         →  Accumulated exports from previous test cases
4. built-ins       →  $UUID, $Timestamp, $RandomEmail, etc.
5. [not found]     →  Keep as {{variableName}} literal (error in strict mode)
```

### Interpolation Syntax

```
{{variableName}}     - Standard variable reference
{{$UUID}}            - Built-in: generates UUID v4
{{$Timestamp}}       - Built-in: current Unix timestamp (seconds)
{{$RandomEmail}}     - Built-in: random email address
{{$RandomInt(1,100)}} - Built-in: random integer in range
```

### JSONPath Export Syntax

```json
{
  "exports": [
    { "name": "token", "jsonPath": "$.data.token" },
    { "name": "userId", "jsonPath": "$.data.user.id" },
    { "name": "firstItem", "jsonPath": "$.items[0].name" }
  ]
}
```

### Implementation

```rust
pub struct ExecutionContext {
    execution_vars: HashMap<String, Value>,  // From execute request
    environment: HashMap<String, Value>,     // From project settings
    context: HashMap<String, Value>,         // Accumulated exports
}

impl ExecutionContext {
    pub fn resolve(&self, name: &str) -> Option<&Value> {
        self.execution_vars.get(name)
            .or_else(|| self.environment.get(name))
            .or_else(|| self.context.get(name))
    }

    pub fn set(&mut self, name: &str, value: Value) {
        self.context.insert(name.to_string(), value);
    }
}
```

---

## Assertion Engine (Rhai)

### Why Rhai?

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **Rhai** | Rust-native, fast startup, small footprint | Less familiar syntax than JS | **Selected** |
| deno_core (V8) | Full JS compatibility | Heavy (40MB+), slow startup | Rejected |
| QuickJS | Lightweight, JS syntax | Requires FFI, less Rust integration | Rejected |
| Native Rust | Maximum performance | No user scripting | Rejected |

### Response Object

The `response` object is available in all assertion scripts:

```rust
response.status      // HTTP status code (i64)
response.body        // Raw response body (String)
response.json        // Parsed JSON (Dynamic/Map)
response.headers     // Response headers (Map<String, String>)
```

### Rhai vs JavaScript Syntax Differences

| JavaScript | Rhai | Notes |
|------------|------|-------|
| `===` | `==` | Rhai has no `===` operator |
| `!==` | `!=` | Same as above |
| `null` | `()` | Rhai uses unit type for null |
| `undefined` | `()` | Same as null |
| `array.length` | `array.len()` | Method call |
| `str.includes("x")` | `str.contains("x")` | Different method name |
| `JSON.parse()` | N/A | Not needed, `response.json` is pre-parsed |

### Assertion Examples

```javascript
// Simple status check
response.status == 200

// Check JSON fields
response.status == 200 && response.json.success == true

// Check array length
response.json.data.len() > 0

// Check string contains
response.json.message.contains("created")

// Check nested object
response.json.user.email.contains("@")

// Complex assertion
response.status == 201 &&
  response.json.user.email.contains("@") &&
  response.json.user.id > 0

// Array element check
response.json.items[0].status == "active"

// Null check
response.json.error == ()
```

### Default Assertion

If no `assertion_script` is provided, the default behavior is:

```rust
// Pass if HTTP status is 2xx
(200..300).contains(&response.status)
```

---

## WebSocket Events

### Event Types

```rust
#[derive(Serialize)]
#[serde(tag = "type")]
enum ExecutionEvent {
    // Execution lifecycle
    ExecutionStarted { execution_id: String, flow_id: String },
    ExecutionCompleted { execution_id: String, status: String, duration_ms: u64 },
    ExecutionFailed { execution_id: String, error: String },
    ExecutionCancelled { execution_id: String },

    // Node lifecycle
    NodeStarted { node_id: String },
    NodeCompleted {
        node_id: String,
        status: String,  // "passed", "failed", "skipped", "error"
        duration_ms: u64,
        exports: Option<HashMap<String, Value>>,
    },
    NodeSkipped { node_id: String, reason: String },

    // Debug events (only when debug_mode = true)
    HttpRequest { node_id: String, method: String, url: String, headers: Value },
    HttpResponse { node_id: String, status: u16, body: String },
    VariableSet { name: String, value: Value },
}
```

### Event Sequence (Happy Path)

```
→ ExecutionStarted { execution_id, flow_id }
  → NodeStarted { node_id: "start-1" }
  → NodeCompleted { node_id: "start-1", status: "passed" }
  → NodeStarted { node_id: "tc-login" }
  → NodeCompleted { node_id: "tc-login", status: "passed", exports: {token: "..."} }
  → NodeStarted { node_id: "tc-profile" }
  → NodeCompleted { node_id: "tc-profile", status: "passed" }
  → NodeStarted { node_id: "end-1" }
  → NodeCompleted { node_id: "end-1", status: "passed" }
→ ExecutionCompleted { execution_id, status: "completed", duration_ms: 1234 }
```

### WebSocket Endpoint

```
GET /api/v1/executions/{id}/ws
```

Client can send:
- `"cancel"` - Request execution cancellation

---

## API Endpoints

### Execute Flow

```http
POST /api/v1/flows/{flow_id}/execute
Content-Type: application/json

{
  "debug_mode": false,
  "environment": {
    "baseUrl": "https://api.example.com",
    "username": "testuser"
  }
}
```

Response (202 Accepted):
```json
{
  "execution_id": "exec-abc123",
  "status": "running",
  "flow_id": "flow-xyz",
  "started_at": "2025-01-15T10:00:00Z"
}
```

### Get Execution Status

```http
GET /api/v1/executions/{execution_id}
```

Response:
```json
{
  "id": "exec-abc123",
  "flow_id": "flow-xyz",
  "status": "completed",
  "debug_mode": false,
  "started_at": "2025-01-15T10:00:00Z",
  "completed_at": "2025-01-15T10:00:05Z",
  "duration_ms": 5234,
  "results": [
    {
      "node_id": "tc-login",
      "status": "passed",
      "duration_ms": 234,
      "request": { "method": "POST", "url": "..." },
      "response": { "status": 200, "body": "..." },
      "exports": { "token": "abc123" }
    }
  ]
}
```

### Cancel Execution

```http
DELETE /api/v1/executions/{execution_id}
```

Response (204 No Content)

### WebSocket Connection

```http
GET /api/v1/executions/{execution_id}/ws
Upgrade: websocket
```

---

## Database Schema

```sql
-- migrations/004_executions.sql

CREATE TABLE IF NOT EXISTS execution_runs (
    id TEXT PRIMARY KEY,
    flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending, running, completed, failed, cancelled
    debug_mode INTEGER NOT NULL DEFAULT 0,
    environment TEXT NOT NULL DEFAULT '{}',  -- JSON: input variables
    context TEXT NOT NULL DEFAULT '{}',      -- JSON: accumulated exports
    started_at TEXT NOT NULL,
    completed_at TEXT,
    duration_ms INTEGER,
    error_message TEXT
);

CREATE TABLE IF NOT EXISTS execution_results (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    test_case_id TEXT,  -- NULL for start/end nodes
    status TEXT NOT NULL,  -- passed, failed, skipped, error
    duration_ms INTEGER,
    request TEXT,   -- JSON: method, url, headers, body
    response TEXT,  -- JSON: status, headers, body
    exports TEXT,   -- JSON: extracted variables
    logs TEXT DEFAULT '[]',  -- JSON: debug logs
    error_message TEXT,
    executed_at TEXT NOT NULL
);

CREATE INDEX idx_execution_runs_flow_id ON execution_runs(flow_id);
CREATE INDEX idx_execution_runs_status ON execution_runs(status);
CREATE INDEX idx_execution_results_execution_id ON execution_results(execution_id);
```

---

## Use Cases

### Use Case 1: Simple Login Flow (Happy Path)

```
┌─────────┐    default    ┌─────────┐    success   ┌─────────┐
│  START  │──────────────▶│  Login  │─────────────▶│   END   │
└─────────┘               └─────────┘              └─────────┘
```

**Execution**:
1. START → passes → follows default edge → Login
2. Login → POST /login → 200 OK → assertion passes → follows success edge → END
3. END → passes → no more edges → **Execution completed**

**Result**: `status: "completed"`, all nodes passed

---

### Use Case 2: Login + Get Profile (Variable Chaining)

```
┌─────────┐    default    ┌─────────┐    success   ┌─────────┐   success   ┌─────────┐
│  START  │──────────────▶│  Login  │─────────────▶│ Profile │────────────▶│   END   │
└─────────┘               └─────────┘              └─────────┘             └─────────┘
                          exports: token            uses: {{token}}
```

**Login Test Case**:
```json
{
  "method": "POST",
  "endpoint": "{{baseUrl}}/login",
  "payload": {"username": "{{username}}", "password": "{{password}}"},
  "exports": [{"name": "token", "jsonPath": "$.data.token"}],
  "assertion_script": "response.status == 200 && response.json.success == true"
}
```

**Profile Test Case**:
```json
{
  "method": "GET",
  "endpoint": "{{baseUrl}}/profile",
  "headers": {"Authorization": "Bearer {{token}}"},
  "assertion_script": "response.status == 200"
}
```

**Execution**:
1. Login executes, exports `token = "abc123"`
2. Profile uses `{{token}}` → resolves to `"abc123"`
3. Both pass → completed

---

### Use Case 3: Branching Flow (Success/Failure Routing)

```
                                    ┌─────────┐
                         success    │ Profile │
                      ┌────────────▶│  (get)  │─────┐
                      │             └─────────┘     │ success
┌─────────┐  default  │                             ▼
│  START  │──────────▶│  Login  │             ┌─────────┐
└─────────┘           └─────────┘             │   END   │
                      │             ┌─────────┐     ▲
                      │   failure   │  Error  │     │ success
                      └────────────▶│  Log    │─────┘
                                    └─────────┘
```

**If Login Passes**: START → Login → Profile → END
**If Login Fails**: START → Login → Error Log → END

Both paths complete successfully (status: "completed")

---

### Use Case 4: Missing Failure Edge

```
┌─────────┐    default    ┌─────────┐    success   ┌─────────┐
│  START  │──────────────▶│  Login  │─────────────▶│   END   │
└─────────┘               └─────────┘              └─────────┘
                           (no failure edge!)
```

**If Login Fails**:
1. Login → 401 Unauthorized → assertion fails
2. Look for failure edge → **none exists**
3. **STOP execution**

**Result**: `status: "stopped"`, `stopped_at_node: "tc-login"`

---

### Use Case 5: Network Error

```
┌─────────┐    default    ┌─────────┐    failure   ┌─────────┐
│  START  │──────────────▶│  Login  │─────────────▶│   END   │
└─────────┘               └─────────┘              └─────────┘
                           ▲
                           │ DNS resolution fails!
```

**Execution**:
1. Login → tries to connect → DNS resolution fails
2. This is an **error**, not a failure
3. **STOP immediately** (don't follow failure edge)

**Result**: `status: "error"`, `error_at_node: "tc-login"`, `error: "DNS resolution failed"`

**Rationale**: Errors indicate infrastructure issues that should be investigated, not test logic issues.

---

## Error Handling

### Error Types

| Error Type | HTTP Status | Description | Action |
|------------|-------------|-------------|--------|
| Flow not found | 404 | Invalid flow_id | Return error |
| Test case not found | 500 | Node references non-existent TC | Stop with error |
| Invalid assertion syntax | 500 | Rhai syntax error | Stop with error |
| Network error | N/A | Connection failed, timeout | Stop with error |
| Assertion error | N/A | Rhai runtime error | Stop with error |
| JSONPath error | N/A | Invalid path or type mismatch | Skip export, continue |

### Error Response Format

```json
{
  "error": {
    "code": "EXECUTION_ERROR",
    "message": "Network error at node tc-login",
    "details": {
      "node_id": "tc-login",
      "error_type": "network",
      "original_error": "Connection refused"
    }
  }
}
```

---

## Graph Validation

Before executing a flow, it should be validated to ensure the graph is well-formed. The GUI provides a "Validate" button that calls this API.

### API Endpoint

```http
POST /api/v1/flows/{flow_id}/validate
```

Response (200 OK):
```json
{
  "valid": false,
  "errors": [
    {
      "code": "NO_START_NODE",
      "message": "Flow must have exactly one START node",
      "severity": "error"
    },
    {
      "code": "ORPHANED_NODE",
      "message": "Node 'tc-cleanup' is not connected to any other node",
      "severity": "error",
      "node_id": "tc-cleanup"
    }
  ],
  "warnings": [
    {
      "code": "NO_FAILURE_EDGE",
      "message": "Node 'tc-login' has no failure edge - execution will stop if test fails",
      "severity": "warning",
      "node_id": "tc-login"
    }
  ]
}
```

If validation passes:
```json
{
  "valid": true,
  "errors": [],
  "warnings": []
}
```

### Validation Rules

#### Errors (Block Execution)

| Code | Description | Details |
|------|-------------|---------|
| `NO_START_NODE` | Flow has no START node | Cannot determine entry point |
| `MULTIPLE_START_NODES` | Flow has more than one START node | Ambiguous entry point |
| `NO_END_NODE` | Flow has no END node | Flow cannot terminate properly |
| `ORPHANED_NODE` | Node has no incoming or outgoing edges | Disconnected from flow |
| `UNREACHABLE_NODE` | Node cannot be reached from START | Dead code in graph |
| `INVALID_EDGE_TARGET` | Edge points to non-existent node | Broken reference |
| `INVALID_EDGE_SOURCE` | Edge originates from non-existent node | Broken reference |
| `CIRCULAR_DEPENDENCY` | Flow contains a cycle (for group nodes) | Infinite recursion risk |
| `MISSING_TEST_CASE` | TestCase node references non-existent test case | Broken reference |
| `MISSING_FLOW_REF` | Group node references non-existent flow | Broken reference |
| `SELF_REFERENCE` | Group node references its own flow | Direct recursion |

#### Warnings (Allow Execution, But Warn User)

| Code | Description | Details |
|------|-------------|---------|
| `NO_FAILURE_EDGE` | TestCase node has no failure edge | Execution stops on failure |
| `NO_SUCCESS_EDGE` | TestCase node has no success/default edge | Dead end on success |
| `DUPLICATE_EDGE` | Multiple edges of same type from one node | Only first will be used |
| `EMPTY_FLOW` | Flow has only START and END nodes | Nothing to execute |
| `UNREACHABLE_END` | END node cannot be reached from any path | Flow may never terminate |

### Validation Response Types

```rust
#[derive(Serialize)]
pub struct ValidationResult {
    pub valid: bool,
    pub errors: Vec<ValidationIssue>,
    pub warnings: Vec<ValidationIssue>,
}

#[derive(Serialize)]
pub struct ValidationIssue {
    pub code: String,
    pub message: String,
    pub severity: String,  // "error" or "warning"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edge_id: Option<String>,
}
```

### Validation Implementation

**Design Decision**: Validator receives repository references and makes targeted DB queries - NOT huge arrays of test cases/flows.

```rust
pub struct GraphValidator<'a> {
    tc_repo: &'a dyn TestCaseRepository,
    flow_repo: &'a dyn FlowRepository,
}

impl<'a> GraphValidator<'a> {
    pub async fn validate(&self, flow: &Flow) -> Result<ValidationResult> {
        let mut errors = Vec::new();
        let mut warnings = Vec::new();

        let graph = parse_graph(&flow.graph_data);

        // === STRUCTURAL CHECKS (no DB needed) ===

        // 1. Check START node
        let start_nodes: Vec<_> = graph.nodes.iter()
            .filter(|n| n.node_type == "start")
            .collect();

        match start_nodes.len() {
            0 => errors.push(error("NO_START_NODE", "Flow must have exactly one START node")),
            1 => {},
            _ => errors.push(error("MULTIPLE_START_NODES", "Flow has multiple START nodes")),
        }

        // 2. Check END node
        if !graph.nodes.iter().any(|n| n.node_type == "end") {
            errors.push(error("NO_END_NODE", "Flow must have at least one END node"));
        }

        // 3. Check orphaned nodes
        for node in &graph.nodes {
            let has_incoming = graph.edges.iter().any(|e| e.target == node.id);
            let has_outgoing = graph.edges.iter().any(|e| e.source == node.id);

            if !has_incoming && !has_outgoing && node.node_type != "start" {
                errors.push(error_with_node(
                    "ORPHANED_NODE",
                    format!("Node '{}' is not connected", node.id),
                    &node.id
                ));
            }
        }

        // 4. Check reachability from START
        if let Some(start) = start_nodes.first() {
            let reachable = find_reachable_nodes(&graph, &start.id);
            for node in &graph.nodes {
                if node.node_type != "start" && !reachable.contains(&node.id) {
                    errors.push(error_with_node(
                        "UNREACHABLE_NODE",
                        format!("Node '{}' cannot be reached from START", node.id),
                        &node.id
                    ));
                }
            }
        }

        // 5. Check edge references (within graph)
        let node_ids: HashSet<_> = graph.nodes.iter().map(|n| &n.id).collect();
        for edge in &graph.edges {
            if !node_ids.contains(&edge.source) {
                errors.push(error_with_edge("INVALID_EDGE_SOURCE",
                    format!("Edge source '{}' does not exist", edge.source), &edge.id));
            }
            if !node_ids.contains(&edge.target) {
                errors.push(error_with_edge("INVALID_EDGE_TARGET",
                    format!("Edge target '{}' does not exist", edge.target), &edge.id));
            }
        }

        // === REFERENCE CHECKS (targeted DB queries) ===

        // 6. Check test case references - SINGLE QUERY
        let referenced_tc_ids: Vec<String> = graph.nodes.iter()
            .filter(|n| n.node_type == "testCase")
            .filter_map(|n| n.data.test_case_id.clone())
            .collect();

        if !referenced_tc_ids.is_empty() {
            let existing_tc_ids = self.tc_repo
                .find_existing_ids(&referenced_tc_ids)
                .await?;

            for node in graph.nodes.iter().filter(|n| n.node_type == "testCase") {
                if let Some(tc_id) = &node.data.test_case_id {
                    if !existing_tc_ids.contains(tc_id) {
                        errors.push(error_with_node(
                            "MISSING_TEST_CASE",
                            format!("Test case '{}' not found", tc_id),
                            &node.id
                        ));
                    }
                }
            }
        }

        // 7. Check group node flow references - SINGLE QUERY
        let referenced_flow_ids: Vec<String> = graph.nodes.iter()
            .filter(|n| n.node_type == "group")
            .filter_map(|n| n.data.flow_id.clone())
            .collect();

        if !referenced_flow_ids.is_empty() {
            let existing_flow_ids = self.flow_repo
                .find_existing_ids(&referenced_flow_ids)
                .await?;

            for node in graph.nodes.iter().filter(|n| n.node_type == "group") {
                if let Some(ref_flow_id) = &node.data.flow_id {
                    // Self-reference check
                    if ref_flow_id == &flow.id {
                        errors.push(error_with_node(
                            "SELF_REFERENCE",
                            "Group node references its own flow",
                            &node.id
                        ));
                    }
                    // Existence check
                    else if !existing_flow_ids.contains(ref_flow_id) {
                        errors.push(error_with_node(
                            "MISSING_FLOW_REF",
                            format!("Flow '{}' not found", ref_flow_id),
                            &node.id
                        ));
                    }
                    // Circular dependency check (lazy - only when needed)
                    else if self.has_circular_dependency(&flow.id, ref_flow_id).await? {
                        errors.push(error_with_node(
                            "CIRCULAR_DEPENDENCY",
                            "Would create circular dependency",
                            &node.id
                        ));
                    }
                }
            }
        }

        // === WARNINGS ===

        // Missing failure edges
        for node in graph.nodes.iter().filter(|n| n.node_type == "testCase") {
            let has_failure = graph.edges.iter()
                .any(|e| e.source == node.id && e.edge_type == "failure");
            if !has_failure {
                warnings.push(warning_with_node(
                    "NO_FAILURE_EDGE",
                    "No failure edge - execution stops if test fails",
                    &node.id
                ));
            }
        }

        // Missing success edges
        for node in graph.nodes.iter().filter(|n| n.node_type == "testCase") {
            let has_success = graph.edges.iter()
                .any(|e| e.source == node.id &&
                     (e.edge_type == "success" || e.edge_type == "default"));
            if !has_success {
                warnings.push(warning_with_node(
                    "NO_SUCCESS_EDGE",
                    "No success edge - dead end on success",
                    &node.id
                ));
            }
        }

        // Empty flow
        let has_test_nodes = graph.nodes.iter()
            .any(|n| n.node_type == "testCase" || n.node_type == "group");
        if !has_test_nodes {
            warnings.push(warning("EMPTY_FLOW", "Flow has no test cases"));
        }

        Ok(ValidationResult {
            valid: errors.is_empty(),
            errors,
            warnings,
        })
    }

    /// Circular dependency check using DFS - queries DB lazily
    async fn has_circular_dependency(
        &self,
        original_flow_id: &str,
        checking_flow_id: &str,
    ) -> Result<bool> {
        let mut visited = HashSet::new();
        self.check_circular_recursive(original_flow_id, checking_flow_id, &mut visited).await
    }

    async fn check_circular_recursive(
        &self,
        original_flow_id: &str,
        checking_flow_id: &str,
        visited: &mut HashSet<String>,
    ) -> Result<bool> {
        if checking_flow_id == original_flow_id {
            return Ok(true);
        }
        if visited.contains(checking_flow_id) {
            return Ok(false);
        }
        visited.insert(checking_flow_id.to_string());

        // Fetch only this flow's graph (not all flows)
        if let Some(flow) = self.flow_repo.get_by_id(checking_flow_id).await? {
            let graph = parse_graph(&flow.graph_data);
            for node in graph.nodes.iter().filter(|n| n.node_type == "group") {
                if let Some(ref nested_flow_id) = node.data.flow_id {
                    if Box::pin(self.check_circular_recursive(
                        original_flow_id, nested_flow_id, visited
                    )).await? {
                        return Ok(true);
                    }
                }
            }
        }
        Ok(false)
    }
}
```

### Repository Method Addition

```rust
// Add to TestCaseRepository trait
async fn find_existing_ids(&self, ids: &[String]) -> Result<HashSet<String>>;

// Implementation
async fn find_existing_ids(&self, ids: &[String]) -> Result<HashSet<String>> {
    // SELECT id FROM test_cases WHERE id IN (?, ?, ?, ...)
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let query = format!("SELECT id FROM test_cases WHERE id IN ({})", placeholders);

    let rows = sqlx::query_scalar(&query)
        .bind_all(ids)
        .fetch_all(&self.pool)
        .await?;

    Ok(rows.into_iter().collect())
}
```

### Validation Timing

| When | What |
|------|------|
| **On demand** | User clicks "Validate" button in GUI |
| **Before execution** | Automatically validated when POST /execute is called |
| **On save** | Optional - can validate on flow save (configurable) |

### Nesting Validation Endpoint

For checking if a flow can be nested into another without creating cycles:

```http
POST /api/v1/flows/{flow_id}/validate-nesting
Content-Type: application/json

{
  "target_flow_id": "flow-to-nest"
}
```

Response:
```json
{
  "can_nest": true
}
```

Or if it would create a cycle:
```json
{
  "can_nest": false,
  "reason": "Would create circular dependency: FlowA → FlowB → FlowA"
}
```

---

## Project Structure

```
api/src/
├── execution/
│   ├── mod.rs              # Module exports
│   ├── engine.rs           # ExecutionEngine (graph traversal)
│   ├── http.rs             # HTTP request executor
│   ├── variables.rs        # Variable interpolation & context
│   ├── assertions.rs       # Rhai assertion engine
│   └── manager.rs          # Async execution manager & WebSocket
├── validation/
│   ├── mod.rs              # Module exports
│   ├── graph.rs            # GraphValidator (structural + reference checks)
│   └── circular.rs         # Circular dependency detection
├── api/
│   ├── executions.rs       # Execution API handlers
│   └── validation.rs       # Validation API handlers
└── ...
```

---

## Dependencies

```toml
# Cargo.toml additions for execution engine

# Scripting engine (Rhai - pure Rust, fast)
rhai = { version = "1.18", features = ["sync"] }

# JSONPath for variable extraction
jsonpath-rust = "0.5"

# WebSocket support
axum = { version = "0.8", features = ["ws"] }
tokio-tungstenite = "0.21"

# Broadcast channels for real-time events
tokio = { version = "1", features = ["full", "sync"] }
```

---

## Future Considerations

1. **Parallel Execution**: Execute independent branches concurrently
2. **Retry Logic**: Configurable retry on transient failures
3. **Timeout Configuration**: Per-test-case and flow-level timeouts
4. **Pre/Post Scripts**: Hooks before/after each test case
5. **Conditional Nodes**: Execute based on variable values
6. **Loop Nodes**: Repeat execution for list items
7. **Group Node Execution**: Nested flow execution (already in design)

---

## References

- Plan File: `/home/rvnath/.claude/plans/zippy-sprouting-anchor.md`
- API Specification: `gui-lov/API_SPECIFICATION.md`
- Legacy Execution: `legacy/src/test_case.rs`, `legacy/src/v8engine.rs`
