-- Execution runs
CREATE TABLE IF NOT EXISTS execution_runs (
    id TEXT PRIMARY KEY,
    flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending, running, completed, failed, cancelled, stopped, error
    debug_mode INTEGER NOT NULL DEFAULT 0,
    environment TEXT NOT NULL DEFAULT '{}',  -- JSON: input variables
    variables TEXT NOT NULL DEFAULT '{}',    -- JSON: accumulated exports during execution
    started_at TEXT NOT NULL,
    completed_at TEXT,
    duration_ms INTEGER,
    error_message TEXT,
    stopped_at_node TEXT  -- Node ID where execution stopped (if stopped/error)
);

-- Execution results for each node
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

-- Indexes
CREATE INDEX IF NOT EXISTS idx_execution_runs_flow_id ON execution_runs(flow_id);
CREATE INDEX IF NOT EXISTS idx_execution_runs_status ON execution_runs(status);
CREATE INDEX IF NOT EXISTS idx_execution_runs_started_at ON execution_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_execution_results_execution_id ON execution_results(execution_id);
