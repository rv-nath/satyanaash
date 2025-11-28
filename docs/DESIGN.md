# Satyanaash 2.0 - Design Document

**Version:** 2.0
**Date:** 2025-01-22
**Status:** Draft
**Related:** REQUIREMENTS.md

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Database Design](#2-database-design)
3. [AST Specification](#3-ast-specification)
4. [Module Structure](#4-module-structure)
5. [Execution Engine](#5-execution-engine)
6. [Event System & WebSocket Streaming](#6-event-system--websocket-streaming)
7. [REST API Specification](#7-rest-api-specification)
8. [Implementation Phases](#8-implementation-phases)
9. [Technology Stack](#9-technology-stack)

---

## 1. Architecture Overview

### 1.1 High-Level Architecture

Satyanaash 2.0 consists of two execution modes:

**1. Excel CLI Mode (Legacy)** - Preserved without changes
- Input: Excel file (.xlsx)
- Execution: Sequential, row-by-row
- Output: Console statistics
- Storage: None (ephemeral)

**2. Project Mode (New)** - Database-backed with graph execution
- Input: SQLite project database OR REST API
- Execution: Graph-based (sequential/parallel/conditional)
- Output: TimescaleDB metrics + WebSocket streaming
- Storage: Persistent (test definitions + execution history)

### 1.2 Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Interfaces                           │
├──────────────┬────────────────────────┬──────────────────────────┤
│  CLI         │      Web GUI           │    REST API Client       │
│              │  (Graph Builder)       │    (Automation)          │
│ - Excel Mode │  - Drag-drop editor    │  - CI/CD integration     │
│ - Import     │  - Visual graph design │  - Scripting             │
│ - Execute    │  - Real-time dashboard │  - Custom tools          │
│ - Query      │                        │                          │
└──────┬───────┴──────────┬─────────────┴────────────┬────────────┘
       │                  │                          │
       ▼                  ▼                          ▼
┌──────────────────────────────────────────────────────────────────┐
│                      Satyanaash Core                              │
│  ┌────────────────┐  ┌────────────────┐  ┌─────────────────┐    │
│  │ Excel Executor │  │ Graph Executor │  │  REST API       │    │
│  │ (Legacy Mode)  │  │ (Project Mode) │  │  (axum)         │    │
│  └────────────────┘  └────────┬───────┘  └────────┬────────┘    │
│                               │                    │             │
│  ┌────────────────────────────┴────────────────────┴───────────┐ │
│  │              Event Broadcaster (WebSocket)                  │ │
│  └────────────────────────────┬────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
       │                        │                        │
       ▼                        ▼                        ▼
┌─────────────┐        ┌──────────────┐       ┌─────────────────┐
│   Console   │        │   SQLite     │       │  TimescaleDB    │
│   Output    │        │ (Projects)   │       │  (Metrics)      │
└─────────────┘        └──────────────┘       └─────────────────┘
```

**Interface Roles:**
- **CLI**: Excel execution (legacy), project import/run/query (NOT graph editing)
- **Web GUI**: Primary interface for creating/editing complex graphs
- **REST API**: Programmatic access for automation and custom integrations

### 1.3 Execution Flow

**Excel Mode:**
```
Excel File → Parse Rows → Execute Sequentially → Print Stats
```

**Project Mode:**
```
SQLite DB → Build Graph → Validate → Execute (Graph Traversal) → Persist Metrics
                                          │
                                          └─→ Stream Events (WebSocket)
```

### 1.4 CLI Commands for Project Mode

**Why CLI is Limited for Project Mode:**
Creating complex graphs with nodes, edges, conditionals, and loops via CLI would be extremely cumbersome. The CLI focuses on **operational tasks** rather than graph design.

**Supported CLI Commands:**

```bash
# Excel → Project Import (creates linear graph from Excel rows)
satyanaash project import <file.xlsx> --name "Project Name"

# List all projects
satyanaash project list

# Get project details
satyanaash project info "Project Name"

# Execute a project
satyanaash project run "Project Name"
satyanaash project run "Project Name" --version 5
satyanaash project run "Project Name" --dry-run

# Step-by-step execution (debugging)
satyanaash project run "Project Name" --step-by-step

# View execution history
satyanaash project history "Project Name"
satyanaash project history "Project Name" --last 10

# Export project
satyanaash project export "Project Name" --format json
satyanaash project export "Project Name" --format excel

# Delete project
satyanaash project delete "Project Name"
```

**NOT Supported via CLI:**
- ❌ Creating/editing graph nodes manually
- ❌ Adding edges between nodes
- ❌ Designing conditional/loop structures
- ❌ Visual graph layout

**For Graph Design, Use:**
- ✅ **Web GUI**: Drag-drop graph editor
- ✅ **REST API**: Programmatic graph construction

---

## 2. Database Design

### 2.1 Project Database (SQLite)

Each project has its own SQLite file: `~/.satyanaash/projects/{project_id}.db`

**Why SQLite per project:**
- Self-contained (single file per project)
- No server required
- Easy backup/sharing (copy file)
- Good performance for single-user
- ACID transactions

#### **Schema: Projects Metadata**

```sql
CREATE TABLE project_metadata (
    id TEXT PRIMARY KEY,              -- UUID
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_project_name ON project_metadata(name);
```

#### **Schema: Versions**

```sql
CREATE TABLE versions (
    id TEXT PRIMARY KEY,              -- UUID
    version_number INTEGER NOT NULL,
    parent_version_id TEXT REFERENCES versions(id),
    commit_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_current BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_version_number ON versions(version_number);
CREATE INDEX idx_current_version ON versions(is_current) WHERE is_current = TRUE;
```

**Version Management:**
- Each change creates new version (snapshot-based)
- `version_number` increments sequentially (1, 2, 3, ...)
- `is_current` flag marks active version
- Old versions immutable (read-only)

#### **Schema: Test Cases**

```sql
CREATE TABLE test_cases (
    id TEXT PRIMARY KEY,              -- UUID
    name TEXT NOT NULL,
    description TEXT,                 -- Detailed explanation (not constrained by Excel visibility)

    -- BDD format
    given TEXT,                       -- Given: precondition
    when_cond TEXT,                   -- When: action
    then_result TEXT,                 -- Then: expected result

    -- HTTP request details
    url TEXT NOT NULL,
    method TEXT NOT NULL CHECK(method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')),
    headers TEXT,                     -- JSON array: [["Content-Type", "application/json"], ...]
    payload TEXT,                     -- Payload content
    payload_type TEXT DEFAULT 'json' CHECK(payload_type IN ('json', 'xml', 'form-data', 'multipart', 'text', 'binary')),

    -- Execution configuration (flattened from previous JSON blob)
    repeat_count INTEGER DEFAULT 1 CHECK(repeat_count >= 1 AND repeat_count <= 100),
    auth_type TEXT DEFAULT 'none' CHECK(auth_type IN ('none', 'authorizer', 'authorized')),
    delay_ms INTEGER DEFAULT 0 CHECK(delay_ms >= 0),
    failure_strategy TEXT DEFAULT 'stop' CHECK(failure_strategy IN ('stop', 'continue', 'retry')),
    retry_count INTEGER DEFAULT 0 CHECK(retry_count >= 0 AND retry_count <= 10),
    retry_delay_ms INTEGER DEFAULT 0 CHECK(retry_delay_ms >= 0),
    propagate_failure BOOLEAN DEFAULT TRUE,

    -- JavaScript execution
    pre_test_script TEXT,             -- Executed before HTTP request
    post_test_script TEXT,            -- Executed for assertions/validation

    -- Metadata
    tags TEXT,                        -- JSON array: ["auth", "critical"]
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_test_case_name ON test_cases(name);
CREATE INDEX idx_test_case_method ON test_cases(method);
CREATE INDEX idx_test_case_auth_type ON test_cases(auth_type);
CREATE INDEX idx_test_case_failure_strategy ON test_cases(failure_strategy);
```

**Benefits of Flattened Schema:**
- ✅ SQL queries: `SELECT * FROM test_cases WHERE retry_count > 0`
- ✅ Database-level validation via CHECK constraints
- ✅ Better indexing and query performance
- ✅ Type safety at database level
- ✅ No JSON parsing overhead
- ✅ Easier to understand and maintain

#### **Schema: Groups**

```sql
CREATE TABLE groups (
    id TEXT PRIMARY KEY,              -- UUID
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_group_name ON groups(name);
```

#### **Schema: Nodes (Graph)**

```sql
CREATE TABLE nodes (
    id TEXT PRIMARY KEY,              -- UUID
    version_id TEXT NOT NULL REFERENCES versions(id),
    node_type TEXT NOT NULL CHECK(node_type IN (
        'test_case',      -- Executes HTTP test
        'group',          -- Executes/calls a group (unified, no separate group_call)
        'conditional',    -- If-then-else branching
        'loop',           -- Repeat execution
        'parallel',       -- Concurrent execution
        'entry',          -- Graph entry point
        'exit'            -- Graph exit point
    )),
    name TEXT,
    parent_id TEXT REFERENCES nodes(id),  -- For hierarchical grouping (optional)
    data TEXT NOT NULL,               -- JSON: node-specific data
    metadata TEXT,                    -- JSON: UI position, color, description
    position INTEGER,                 -- Order within parent
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_node_version ON nodes(version_id);
CREATE INDEX idx_node_type ON nodes(node_type);
CREATE INDEX idx_node_parent ON nodes(parent_id);
```

**Note:** `group_call` removed - unified with `group` node type. Context determines behavior.

**Node Data JSON by Type:**

**Test Case Node:**
```json
{
  "test_case_id": "uuid",
  "failureStrategy": "stop",
  "retryCount": 0
}
```

**Group Call Node:**
```json
{
  "group_id": "uuid",
  "group_name": "Login"
}
```

**Conditional Node:**
```json
{
  "condition": "SAT.response.status === 200",
  "true_branch_id": "node_uuid",
  "false_branch_id": "node_uuid"
}
```

**Loop Node:**
```json
{
  "loop_type": "count",
  "count": 10,
  "condition": "SAT.globals.i < 10",
  "max_iterations": 100
}
```

**Parallel Node:**
```json
{
  "branches": [
    ["node_uuid_1", "node_uuid_2"],
    ["node_uuid_3", "node_uuid_4"]
  ],
  "join_strategy": "wait_all"
}
```

#### **Schema: Edges**

```sql
CREATE TABLE edges (
    id TEXT PRIMARY KEY,              -- UUID
    version_id TEXT NOT NULL REFERENCES versions(id),
    from_node_id TEXT NOT NULL REFERENCES nodes(id),
    to_node_id TEXT NOT NULL REFERENCES nodes(id),
    edge_type TEXT NOT NULL CHECK(edge_type IN ('always', 'on_success', 'on_failure', 'custom', 'http_status')),
    condition TEXT,                   -- JavaScript expression (for 'custom' type)
    http_status_code INTEGER,         -- HTTP status code (for 'http_status' type)
    priority INTEGER DEFAULT 0 CHECK(priority >= 0),       -- Higher priority evaluated first
    metadata TEXT,                    -- JSON: UI styling (color, label)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_edge_version ON edges(version_id);
CREATE INDEX idx_edge_from ON edges(from_node_id);
CREATE INDEX idx_edge_to ON edges(to_node_id);
CREATE INDEX idx_edge_priority ON edges(priority DESC);
CREATE INDEX idx_edge_type ON edges(edge_type);
```

**Hybrid Edge Type Design:**
- `always`: Always traverse (no condition evaluation)
- `on_success`: Traverse if previous node succeeded
- `on_failure`: Traverse if previous node failed
- `custom`: Traverse if JavaScript condition evaluates to true (stored in `condition` field)
- `http_status`: Traverse if HTTP status matches (stored in `http_status_code` field)

**Benefits:**
- ✅ 90% of edges use simple routing (no JS evaluation needed)
- ✅ Type safety for common cases
- ✅ Performance: Fast path for always/success/failure edges
- ✅ Flexibility: `custom` edges support any JavaScript condition

---

### 2.2 Metrics Database (TimescaleDB)

Centralized time-series database for all execution metrics across all projects.

**Why TimescaleDB:**
- PostgreSQL extension (familiar SQL)
- Optimized for time-series data
- Automatic partitioning by time
- Excellent compression
- Built-in retention policies

#### **Schema: Test Runs**

```sql
CREATE TABLE test_runs (
    time TIMESTAMPTZ NOT NULL,
    run_id UUID NOT NULL,
    project_id UUID NOT NULL,
    project_name TEXT,
    version_id UUID,
    status TEXT NOT NULL,             -- 'running', 'completed', 'failed', 'aborted'
    total INTEGER,
    passed INTEGER,
    failed INTEGER,
    skipped INTEGER,
    duration_ms INTEGER,
    metadata JSONB,                   -- Additional run metadata
    PRIMARY KEY (time, run_id)
);

-- Convert to hypertable (TimescaleDB specific)
SELECT create_hypertable('test_runs', 'time');

-- Create indexes
CREATE INDEX idx_test_runs_project ON test_runs(project_id, time DESC);
CREATE INDEX idx_test_runs_status ON test_runs(status, time DESC);
```

#### **Schema: Test Results**

```sql
CREATE TABLE test_results (
    time TIMESTAMPTZ NOT NULL,
    run_id UUID NOT NULL,
    node_id UUID NOT NULL,
    node_name TEXT,
    node_type TEXT,                   -- 'test_case', 'group'
    status TEXT NOT NULL,             -- 'passed', 'failed', 'skipped'
    http_status INTEGER,
    duration_ms INTEGER,
    error_message TEXT,
    request JSONB,                    -- Full HTTP request
    response JSONB,                   -- Full HTTP response
    PRIMARY KEY (time, run_id, node_id)
);

SELECT create_hypertable('test_results', 'time');

CREATE INDEX idx_test_results_run ON test_results(run_id, time DESC);
CREATE INDEX idx_test_results_node ON test_results(node_id, time DESC);
CREATE INDEX idx_test_results_status ON test_results(status, time DESC);
```

#### **Retention Policies**

```sql
-- Detailed results: 90 days
SELECT add_retention_policy('test_results', INTERVAL '90 days');

-- Aggregate summaries: 1 year (use continuous aggregates)
CREATE MATERIALIZED VIEW test_runs_daily
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', time) AS day,
    project_id,
    COUNT(*) AS run_count,
    AVG(duration_ms) AS avg_duration,
    SUM(passed) AS total_passed,
    SUM(failed) AS total_failed
FROM test_runs
GROUP BY day, project_id;

SELECT add_retention_policy('test_runs', INTERVAL '1 year');
```

---

## 3. Graph Specification

### 3.1 Core Graph Types (Rust)

```rust
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

pub type NodeId = String;  // UUID as string
pub type EdgeId = String;

/// Top-level graph structure
pub struct TestGraph {
    pub version_id: String,
    pub nodes: HashMap<NodeId, GraphNode>,
    pub edges: HashMap<EdgeId, Edge>,
    pub entry_node: NodeId,
    pub exit_nodes: Vec<NodeId>,
    pub metadata: GraphMetadata,
}

pub struct GraphMetadata {
    pub name: String,
    pub description: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}
```

### 3.2 Node Types

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum GraphNode {
    /// Executes a single HTTP test
    TestCase {
        id: NodeId,
        test_case_id: String,        // References test_cases table
        failure_strategy: FailureStrategy,
        retry_config: Option<RetryConfig>,
        metadata: NodeMetadata,
    },

    /// Executes/calls a group (unified - context determines behavior)
    /// - Suite-level: Executes the group as a major component
    /// - Group-level: Calls the group like a function/subroutine
    Group {
        id: NodeId,
        group_id: String,
        group_name: String,
        internal_graph: Option<Box<TestGraph>>,  // Nested graph
        failure_strategy: FailureStrategy,
        metadata: NodeMetadata,
    },

    /// If-then-else branching
    Conditional {
        id: NodeId,
        condition: String,           // JavaScript expression
        true_branch: NodeId,
        false_branch: NodeId,
        metadata: NodeMetadata,
    },

    /// Loop/repeat
    Loop {
        id: NodeId,
        loop_type: LoopType,
        body: Vec<NodeId>,
        metadata: NodeMetadata,
    },

    /// Parallel execution
    Parallel {
        id: NodeId,
        branches: Vec<Vec<NodeId>>,
        join_strategy: JoinStrategy,
        metadata: NodeMetadata,
    },

    /// Graph entry point
    Entry {
        id: NodeId,
    },

    /// Graph exit point
    Exit {
        id: NodeId,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeMetadata {
    pub label: Option<String>,
    pub description: Option<String>,
    pub position: Option<(f32, f32)>,   // For GUI visualization
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum FailureStrategy {
    Stop,           // Stop execution immediately
    Continue,       // Mark as failed, continue to next node
    Retry(RetryConfig),  // Retry N times before failing
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryConfig {
    pub count: u32,        // Max retry attempts
    pub delay_ms: u64,     // Delay between retries
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum LoopType {
    Count(u32),                  // Repeat N times
    WhilePre(String),            // Check condition before each iteration
    WhilePost(String),           // Check condition after each iteration
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum JoinStrategy {
    WaitAll,       // Wait for all branches to complete
    WaitAny,       // Continue after first branch completes
    WaitN(usize),  // Continue after N branches complete
}
```

### 3.3 Edge Types

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edge {
    pub id: EdgeId,
    pub from: NodeId,
    pub to: NodeId,
    pub edge_type: EdgeType,
    pub priority: u32,             // Higher priority evaluated first
    pub metadata: EdgeMetadata,
}

/// Hybrid edge type design: typed for common cases, flexible for custom conditions
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EdgeType {
    /// Always traverse (unconditional)
    Always,

    /// Traverse if previous node succeeded
    OnSuccess,

    /// Traverse if previous node failed
    OnFailure,

    /// Traverse if JavaScript condition evaluates to true
    Custom { condition: String },

    /// Traverse if HTTP status code matches
    HttpStatus { code: u16 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeMetadata {
    pub label: Option<String>,
    pub color: Option<String>,
}
```

### 3.4 Test Case Data

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestCaseData {
    pub id: String,
    pub name: String,
    pub given: String,
    pub when: String,
    pub then: String,
    pub url: String,
    pub method: reqwest::Method,
    pub headers: Vec<(String, String)>,
    pub payload: String,
    pub config: TestCaseConfig,
    pub pre_test_script: Option<String>,
    pub post_test_script: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestCaseConfig {
    pub repeat_count: u32,
    pub auth_type: AuthType,
    pub delay: u64,
    pub failure_strategy: FailureStrategy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthType {
    None,
    Authorizer,    // Generates JWT token
    Authorized,    // Consumes JWT token
}
```

---

## 4. Module Structure

### 4.1 Project Layout

```
src/
├── main.rs                     # CLI entry point (Excel mode + Project operations)
├── lib.rs                      # Public API
├── config.rs                   # Configuration
│
├── cli/                        # CLI commands
│   ├── mod.rs
│   ├── excel.rs                # Excel mode commands
│   └── project.rs              # Project operations (import, run, query, export)
│
├── excel/                      # Excel-based execution (legacy)
│   ├── mod.rs
│   ├── test_suite.rs
│   ├── test_group.rs
│   └── test_case.rs
│
├── graph/                      # Graph-based execution
│   ├── mod.rs
│   ├── types.rs                # GraphNode, Edge, TestGraph
│   ├── builder.rs              # Excel → Graph, DB → Graph
│   ├── executor.rs             # Graph execution engine
│   ├── validator.rs            # Graph validation (cycles, reachability)
│   └── traversal.rs            # Graph traversal algorithms
│
├── db/                         # Database layer
│   ├── mod.rs
│   ├── projects.rs             # Project CRUD operations
│   ├── versions.rs             # Version management
│   ├── test_cases.rs           # Test case CRUD
│   ├── groups.rs               # Group CRUD
│   ├── nodes.rs                # Graph node CRUD
│   ├── edges.rs                # Graph edge CRUD
│   ├── migrations/             # SQL schema migrations
│   │   ├── 001_initial.sql
│   │   ├── 002_add_versions.sql
│   │   └── ...
│   └── metrics.rs              # TimescaleDB interface
│
├── execution/                  # Execution runtime
│   ├── mod.rs
│   ├── context.rs              # ExecutionContext, TestCtx
│   ├── test_runner.rs          # HTTP test execution
│   ├── parallel.rs             # Parallel execution (thread-per-branch)
│   ├── shared_state.rs         # Arc<RwLock<>> for JWT tokens, vars
│   └── call_stack.rs           # Group call stack management
│
├── events/                     # Event system
│   ├── mod.rs
│   ├── types.rs                # Event enums (Serialize/Deserialize)
│   └── broadcaster.rs          # WebSocket event broadcasting
│
├── web/                        # Web server (Graph design + execution)
│   ├── mod.rs
│   ├── api/                    # REST API handlers
│   │   ├── mod.rs
│   │   ├── projects.rs         # Project CRUD
│   │   ├── test_cases.rs       # Test case CRUD
│   │   ├── groups.rs           # Group CRUD
│   │   ├── nodes.rs            # Graph node/edge CRUD (for GUI)
│   │   ├── executions.rs       # Execute & monitor
│   │   └── metrics.rs          # Historical metrics
│   └── websocket.rs            # WebSocket handler
│
└── v8engine.rs                 # JavaScript runtime (unchanged)
```

**Note on CLI:** The `cli/` module handles operational commands only (import, run, query, export). Graph design/editing is exclusively through Web GUI and REST API.

### 4.2 Dependency Graph

```
┌─────────┐
│  main   │
└────┬────┘
     │
     ├─→ cli
     │    ├─→ excel (Excel mode commands)
     │    └─→ project (Project operations: import, run, query)
     │
     ├─→ config
     ├─→ excel (legacy executor)
     ├─→ graph (graph executor)
     ├─→ web (API server + GUI backend)
     │    └─→ api (REST endpoints)
     │
     └─→ events
         │
         ├─→ execution
         │    ├─→ context
         │    ├─→ parallel
         │    └─→ v8engine
         │
         └─→ db
              ├─→ projects
              ├─→ nodes/edges
              └─→ metrics
```

---

## 5. Execution Engine

### 5.1 Graph Executor Architecture

```rust
pub struct GraphExecutor {
    config: Arc<Config>,
    event_tx: Sender<TestEvent>,
}

impl GraphExecutor {
    pub fn execute(&self, graph: TestGraph, project_id: String) -> Result<ExecutionResult> {
        // 1. Create execution context
        let mut ctx = ExecutionContext::new(&self.config, project_id);

        // 2. Start execution from entry node
        self.execute_node(graph.entry_node.clone(), &graph, &mut ctx)?;

        // 3. Collect statistics
        Ok(ctx.into_result())
    }

    fn execute_node(
        &self,
        node_id: NodeId,
        graph: &TestGraph,
        ctx: &mut ExecutionContext,
    ) -> Result<NodeResult> {
        let node = graph.nodes.get(&node_id).ok_or("Node not found")?;

        match node {
            GraphNode::TestCase { test_case_id, .. } => {
                self.execute_test_case(test_case_id, ctx)
            }

            GraphNode::Group { group_id, .. } => {
                self.execute_group_call(group_id, ctx)
            }

            GraphNode::Conditional { condition, true_branch, false_branch, .. } => {
                let result = ctx.test_ctx.runtime.eval(condition)?;
                let next_node = if result.as_bool() == Some(true) {
                    true_branch
                } else {
                    false_branch
                };
                self.execute_node(next_node.clone(), graph, ctx)
            }

            GraphNode::Loop { loop_type, body, .. } => {
                self.execute_loop(loop_type, body, graph, ctx)
            }

            GraphNode::Parallel { branches, join_strategy, .. } => {
                self.execute_parallel(branches, join_strategy, graph, ctx)
            }

            GraphNode::Exit => Ok(NodeResult::Success),

            _ => Ok(NodeResult::Success),
        }
    }
}
```

### 5.2 Execution Context

```rust
pub struct ExecutionContext {
    pub test_ctx: TestCtx,              // HTTP client + JS runtime
    pub call_stack: Vec<CallFrame>,     // For group calls
    pub shared_state: Arc<RwLock<SharedState>>,
    pub statistics: Statistics,
    pub project_id: String,
}

pub struct CallFrame {
    pub group_id: String,
    pub group_name: String,
    pub local_vars: HashMap<String, serde_json::Value>,
}

pub struct SharedState {
    pub jwt_tokens: HashMap<String, String>,
    pub global_vars: HashMap<String, serde_json::Value>,
}

pub struct Statistics {
    pub total: usize,
    pub passed: usize,
    pub failed: usize,
    pub skipped: usize,
    pub duration: Duration,
}
```

### 5.3 Group Call Execution

```rust
impl GraphExecutor {
    fn execute_group_call(
        &self,
        group_id: &str,
        ctx: &mut ExecutionContext,
    ) -> Result<NodeResult> {
        // 1. Load group graph from database
        let group_graph = self.db.load_group_graph(group_id)?;

        // 2. Push call frame
        ctx.call_stack.push(CallFrame {
            group_id: group_id.to_string(),
            group_name: group_graph.metadata.name.clone(),
            local_vars: HashMap::new(),
        });

        // 3. Check max call depth
        if ctx.call_stack.len() > MAX_CALL_DEPTH {
            return Err("Max call depth exceeded".into());
        }

        // 4. Execute group
        let result = self.execute_node(
            group_graph.entry_node.clone(),
            &group_graph,
            ctx,
        )?;

        // 5. Pop call frame
        ctx.call_stack.pop();

        Ok(result)
    }
}
```

### 5.4 Parallel Execution (Thread-per-Branch)

```rust
impl GraphExecutor {
    fn execute_parallel(
        &self,
        branches: &Vec<Vec<NodeId>>,
        join_strategy: &JoinStrategy,
        graph: &TestGraph,
        ctx: &mut ExecutionContext,
    ) -> Result<NodeResult> {
        use std::thread;
        use std::sync::mpsc::channel;

        let (result_tx, result_rx) = channel();
        let mut handles = vec![];

        // Spawn thread per branch
        for (i, branch) in branches.iter().enumerate() {
            let branch = branch.clone();
            let graph = graph.clone();
            let config = self.config.clone();
            let event_tx = self.event_tx.clone();
            let result_tx = result_tx.clone();
            let shared_state = ctx.shared_state.clone();

            let handle = thread::spawn(move || {
                // Create isolated context for this branch
                let mut branch_ctx = ExecutionContext::new_with_shared(
                    &config,
                    ctx.project_id.clone(),
                    shared_state,
                );

                // Execute branch
                for node_id in branch {
                    match self.execute_node(node_id, &graph, &mut branch_ctx) {
                        Ok(NodeResult::Success) => continue,
                        Ok(NodeResult::Failure) => {
                            result_tx.send((i, NodeResult::Failure)).ok();
                            return;
                        }
                        Err(e) => {
                            result_tx.send((i, NodeResult::Failure)).ok();
                            return;
                        }
                    }
                }

                result_tx.send((i, NodeResult::Success)).ok();
            });

            handles.push(handle);
        }

        // Wait based on join strategy
        match join_strategy {
            JoinStrategy::WaitAll => {
                for handle in handles {
                    handle.join().ok();
                }
                Ok(NodeResult::Success)
            }

            JoinStrategy::WaitAny => {
                let (_, result) = result_rx.recv()?;
                Ok(result)
            }

            JoinStrategy::WaitN(n) => {
                for _ in 0..*n {
                    result_rx.recv()?;
                }
                Ok(NodeResult::Success)
            }
        }
    }
}
```

---

## 6. Event System & WebSocket Streaming

### 6.1 Event Types

```rust
use serde::{Serialize, Deserialize};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TestEvent {
    SuiteBegin(SuiteBeginEvent),
    SuiteEnd(SuiteEndEvent),
    GroupBegin(GroupBeginEvent),
    GroupEnd(GroupEndEvent),
    TestCaseBegin(TestCaseBeginEvent),
    TestCaseEnd(TestCaseEndEvent),
    NodeExecutionBegin(NodeExecutionEvent),
    NodeExecutionEnd(NodeExecutionEvent),
    EdgeTraversal(EdgeTraversalEvent),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuiteBeginEvent {
    pub timestamp: DateTime<Utc>,
    pub run_id: String,
    pub project_id: String,
    pub version_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestCaseEndEvent {
    pub timestamp: DateTime<Utc>,
    pub run_id: String,
    pub test_case_id: String,
    pub status: String,        // "passed", "failed", "skipped"
    pub duration_ms: u64,
    pub http_status: Option<u16>,
    pub error_message: Option<String>,
}
```

### 6.2 Event Broadcaster

```rust
use tokio::sync::broadcast;
use std::sync::Arc;

pub struct EventBroadcaster {
    tx: broadcast::Sender<TestEvent>,
}

impl EventBroadcaster {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(1000);
        Self { tx }
    }

    pub fn broadcast(&self, event: TestEvent) {
        let _ = self.tx.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<TestEvent> {
        self.tx.subscribe()
    }
}
```

### 6.3 WebSocket Handler

```rust
use axum::{
    extract::{ws::{WebSocket, WebSocketUpgrade}, State},
    response::Response,
};

pub async fn websocket_handler(
    ws: WebSocketUpgrade,
    State(broadcaster): State<Arc<EventBroadcaster>>,
) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, broadcaster))
}

async fn handle_socket(mut socket: WebSocket, broadcaster: Arc<EventBroadcaster>) {
    let mut rx = broadcaster.subscribe();

    while let Ok(event) = rx.recv().await {
        let json = serde_json::to_string(&event).unwrap();
        if socket.send(axum::extract::ws::Message::Text(json)).await.is_err() {
            break;
        }
    }
}
```

---

## 7. REST API Specification

### 7.1 API Base URL

```
http://localhost:8080/api
```

### 7.2 Projects API

#### **Create Project**
```http
POST /api/projects
Content-Type: application/json

{
  "name": "My API Tests",
  "description": "Authentication and user management tests"
}

Response: 201 Created
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "My API Tests",
  "description": "Authentication and user management tests",
  "created_at": "2025-01-22T10:00:00Z"
}
```

#### **List Projects**
```http
GET /api/projects?page=1&limit=20

Response: 200 OK
{
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "My API Tests",
      "description": "Authentication and user management tests",
      "test_count": 45,
      "group_count": 8,
      "last_modified": "2025-01-22T10:30:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total_items": 50,
    "total_pages": 3,
    "has_next": true,
    "has_prev": false
  }
}
```

#### **Get Project Details**
```http
GET /api/projects/:id

Response: 200 OK
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "My API Tests",
  "description": "Authentication and user management tests",
  "current_version": 5,
  "test_count": 45,
  "group_count": 8,
  "created_at": "2025-01-22T10:00:00Z",
  "updated_at": "2025-01-22T10:30:00Z",
  "groups": ["Login", "UserManagement", "Cleanup"],
  "stats": {
    "last_run_status": "completed",
    "pass_rate": 0.95
  }
}
```

#### **Update Project**
```http
PUT /api/projects/:id
Content-Type: application/json

{
  "name": "Updated Name",
  "description": "Updated description"
}

Response: 200 OK
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "Updated Name",
  "description": "Updated description",
  "updated_at": "2025-01-22T11:00:00Z"
}
```

#### **Delete Project**
```http
DELETE /api/projects/:id

Response: 204 No Content
```

### 7.3 Test Cases API

#### **Create Test Case**
```http
POST /api/projects/:projectId/tests
Content-Type: application/json

{
  "name": "Login Test",
  "given": "User has valid credentials",
  "when": "POST /api/login",
  "then": "Returns 200 with JWT token",
  "url": "/api/login",
  "method": "POST",
  "headers": [
    ["Content-Type", "application/json"]
  ],
  "payload": "{\"username\":\"test\",\"password\":\"pass123\"}",
  "config": {
    "authType": "authorizer",
    "failureStrategy": "stop"
  },
  "preTestScript": "SAT.globals.timestamp = Date.now();",
  "postTestScript": "return SAT.response.status === 200;",
  "tags": ["auth", "critical"]
}

Response: 201 Created
{
  "id": "test-uuid",
  "name": "Login Test",
  ...
}
```

#### **List Test Cases**
```http
GET /api/projects/:projectId/tests?tags=auth&search=login&page=1&limit=50

Response: 200 OK
{
  "data": [
    {
      "id": "test-uuid",
      "name": "Login Test",
      "url": "/api/login",
      "method": "POST",
      "tags": ["auth", "critical"]
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total_items": 120,
    "total_pages": 3,
    "has_next": true,
    "has_prev": false
  }
}
```

### 7.4 Executions API

#### **Execute Project**
```http
POST /api/projects/:projectId/execute
Content-Type: application/json

{
  "version": "latest",
  "dry_run": false
}

Response: 202 Accepted
{
  "run_id": "run-uuid",
  "status": "running",
  "websocket_url": "ws://localhost:8080/api/ws/:run_id"
}
```

#### **Get Execution Status**
```http
GET /api/executions/:runId

Response: 200 OK
{
  "run_id": "run-uuid",
  "project_id": "project-uuid",
  "status": "completed",
  "total": 45,
  "passed": 43,
  "failed": 2,
  "skipped": 0,
  "duration_ms": 12500,
  "started_at": "2025-01-22T10:00:00Z",
  "ended_at": "2025-01-22T10:00:12Z"
}
```

### 7.5 Step-by-Step Execution API

Step-by-step execution mode allows debugging by executing one node at a time, inspecting state between steps.

#### **Start Step-by-Step Execution**
```http
POST /api/projects/:projectId/execute/step
Content-Type: application/json

{
  "version": "latest"
}

Response: 201 Created
{
  "session_id": "step-session-uuid",
  "status": "paused",
  "current_node": "entry-node-id",
  "next_nodes": ["node-1", "node-2"],
  "execution_state": {
    "globals": {},
    "call_stack": []
  }
}
```

#### **Execute Next Step**
```http
POST /api/executions/step/:sessionId/next
Content-Type: application/json

{
  "node_id": "node-1"  // Optional: which node to execute if multiple choices
}

Response: 200 OK
{
  "session_id": "step-session-uuid",
  "status": "paused",
  "executed_node": {
    "id": "node-1",
    "type": "test_case",
    "name": "Login Test",
    "result": "passed",
    "duration_ms": 150,
    "http_status": 200
  },
  "current_node": "node-2",
  "next_nodes": ["node-3", "node-4"],
  "execution_state": {
    "globals": {
      "access_token": "jwt-token-here"
    },
    "call_stack": []
  }
}
```

#### **Get Step Execution State**
```http
GET /api/executions/step/:sessionId

Response: 200 OK
{
  "session_id": "step-session-uuid",
  "status": "paused",
  "current_node": "node-2",
  "execution_history": [
    {
      "node_id": "entry-node-id",
      "timestamp": "2025-01-22T10:00:00Z"
    },
    {
      "node_id": "node-1",
      "result": "passed",
      "timestamp": "2025-01-22T10:00:01Z"
    }
  ],
  "execution_state": {
    "globals": {},
    "call_stack": []
  }
}
```

#### **Resume Full Execution**
```http
POST /api/executions/step/:sessionId/resume

Response: 200 OK
{
  "session_id": "step-session-uuid",
  "status": "running",
  "message": "Execution resumed in normal mode"
}
```

#### **Abort Step Execution**
```http
DELETE /api/executions/step/:sessionId

Response: 204 No Content
```

---

## 8. Implementation Phases

### Phase 1: Foundation (Weeks 1-2)
**Goal:** Refactor existing code, set up database infrastructure

**Tasks:**
- [ ] Refactor existing code into `excel/` module
- [ ] Create database schema (SQLite + TimescaleDB)
- [ ] Implement database migrations
- [ ] Add event serialization (change `Instant` to `DateTime<Utc>`)
- [ ] Set up project structure (`cli/`, `graph/`, `db/`, `execution/`, `web/`)
- [ ] Implement basic CLI commands (import, list, info, run)

**Deliverables:**
- Refactored codebase with clear module boundaries
- Database schemas ready
- CLI can import Excel files to projects
- All existing tests pass

---

### Phase 2: Graph Core (Weeks 3-4)
**Goal:** Implement graph data structures and sequential execution

**Tasks:**
- [ ] Implement graph types (`GraphNode`, `Edge`, `TestGraph`)
- [ ] Build Excel → Graph converter (reuses existing `TestCase::new()`)
- [ ] Implement DB → Graph loader
- [ ] Implement sequential GraphExecutor (graph traversal)
- [ ] Implement graph validator (cycle detection, reachability)

**Deliverables:**
- Excel files can be imported as graph
- Graph can be stored in/loaded from database
- Sequential graph execution matches Excel mode behavior

---

### Phase 3: Database Integration (Weeks 5-6)
**Goal:** Full database CRUD operations and persistence

**Tasks:**
- [ ] Implement project CRUD API (REST)
- [ ] Implement test case CRUD API (REST)
- [ ] Implement group CRUD API (REST)
- [ ] Implement graph node/edge CRUD API (REST)
- [ ] Implement version management (snapshots)
- [ ] Build CLI commands for operational tasks (import, run, query, export - NOT graph editing)

**Deliverables:**
- Projects can be created, listed, queried via REST API
- Test cases can be managed via REST API
- CLI supports import, execute, query operations
- Version history tracked

---

### Phase 4: Control Flow (Weeks 7-8)
**Goal:** Add conditional, loop, and group call nodes

**Tasks:**
- [ ] Implement conditional node execution
- [ ] Implement loop node execution (count, while pre/post)
- [ ] Implement group call execution (call stack)
- [ ] Implement edge condition evaluation
- [ ] Add edge priority resolution

**Deliverables:**
- Conditional routing works
- Loops execute correctly
- Groups can call other groups

---

### Phase 5: Parallel Execution (Weeks 9-10)
**Goal:** Multi-threaded test execution

**Tasks:**
- [ ] Implement thread-per-branch executor
- [ ] Implement parallel node execution
- [ ] Implement join strategies (WaitAll, WaitAny, WaitN)
- [ ] Implement isolated execution contexts per thread
- [ ] Implement shared state (Arc<RwLock<>>)

**Deliverables:**
- Parallel execution works
- 3-5x speedup for independent tests

---

### Phase 6: Real-Time Streaming (Weeks 11-12)
**Goal:** WebSocket event streaming and metrics persistence

**Tasks:**
- [ ] Implement EventBroadcaster (mpsc → broadcast)
- [ ] Implement WebSocket server (axum)
- [ ] Implement TimescaleDB metrics writer
- [ ] Add execution history queries
- [ ] Implement retention policies

**Deliverables:**
- Real-time execution updates via WebSocket
- Metrics persisted to TimescaleDB
- Historical data queryable

---

### Phase 7: Web GUI (Weeks 13-16)
**Goal:** Full web-based test management interface

**Tasks:**
- [ ] Design REST API (complete spec)
- [ ] Build React frontend with graph editor
- [ ] Implement drag-drop test builder (react-flow)
- [ ] Add graph visualization
- [ ] Implement execution dashboard
- [ ] Add metrics/analytics views

**Deliverables:**
- Complete web GUI for test management
- Visual graph editing
- Real-time execution dashboard

---

## 9. Technology Stack

### 9.1 Backend (Rust)

#### **Core Dependencies**
```toml
[dependencies]
# Web framework
axum = "0.7"                    # Modern, ergonomic web framework
tower = "0.4"                   # Middleware
tower-http = "0.5"              # HTTP middleware (CORS, etc.)

# Database
sqlx = { version = "0.7", features = ["runtime-tokio", "sqlite", "postgres", "macros", "chrono", "uuid"] }

# WebSocket
tokio-tungstenite = "0.21"

# Async runtime
tokio = { version = "1", features = ["full"] }

# Serialization
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# Existing dependencies (keep)
calamine = "0.24.0"
reqwest = { version = "0.11", features = ["blocking", "json", "multipart"] }
deno_core = "0.283.0"
uuid = { version = "1", features = ["v4", "serde"] }
chrono = { version = "0.4", features = ["serde"] }

# Graph algorithms
petgraph = "0.6"                # For cycle detection, topological sort

# Logging
tracing = "0.1"
tracing-subscriber = "0.3"
```

#### **Database Choices**
- **SQLite**: Projects (per-project .db files)
  - Advantages: Self-contained, no server, easy backup
  - Library: `sqlx` with `sqlite` feature

- **TimescaleDB**: Execution metrics (centralized)
  - Advantages: PostgreSQL extension, time-series optimized
  - Library: `sqlx` with `postgres` feature
  - Alternative: InfluxDB (if preferred)

### 9.2 Frontend (Web GUI)

```json
{
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-flow-renderer": "^10.3.17",
    "@tanstack/react-query": "^5.0.0",
    "zustand": "^4.4.0",
    "axios": "^1.6.0"
  }
}
```

- **Framework**: React + TypeScript
- **Graph Editor**: react-flow (drag-drop node editor)
- **State Management**: Zustand (simpler than Redux)
- **API Client**: @tanstack/react-query (data fetching)
- **WebSocket**: Native WebSocket API
- **UI Components**: shadcn/ui or MUI

---

## 10. Deployment

### 10.1 Single Binary Deployment

**Embedded Web Server Approach:**
```rust
// Embed static frontend files in binary
#[derive(RustEmbed)]
#[folder = "web/dist/"]
struct Assets;

// Serve static files + API from same binary
async fn serve_asset(Path(path): Path<String>) -> impl IntoResponse {
    Assets::get(&path)
        .map(|content| Response::new(content.data.into()))
        .unwrap_or_else(|| Response::new("Not found".into()))
}
```

**Benefits:**
- Single binary distribution
- No separate frontend deployment
- Works offline

### 10.2 Separate Deployment (Optional)

- **Backend**: Rust binary (API server + WebSocket)
- **Frontend**: Static files (Nginx/Caddy)
- **Databases**: SQLite files + TimescaleDB instance

---

## 11. Open Questions

1. **WebSocket Protocol**: Use JSON or MessagePack for events?
2. **Graph Editor**: react-flow vs cytoscape.js?
3. **TimescaleDB**: Required or make metrics DB pluggable (InfluxDB/Prometheus)?
4. **Max Graph Size**: Limit nodes per graph? (e.g., 10,000 nodes)
5. **Call Stack Depth**: Max depth 100? Configurable?

---

**Document Status:** Draft
**Next Steps:**
1. Review and approve design
2. Begin Phase 1 implementation
3. Set up development environment
4. Create GitHub project/issues for task tracking
