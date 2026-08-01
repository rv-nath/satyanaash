-- Suites and run history.
--
-- A run is an execution of a suite, so the selection and the record share one schema.
-- Four levels, because a run has four: the suite run, each member, each node, each row.
--
-- Note for a future PostgreSQL port: BLOB is SQLite's spelling, and Postgres wants
-- BYTEA. Do not "portably" declare these columns BYTEA — SQLite gives an unrecognised
-- type name NUMERIC affinity, which would mangle compressed bytes on the way in.
--
-- Keep semicolons out of these comments. run_migrations splits the file on them and
-- would take the tail of a comment for a statement.

-- Clean up the two tables 004 used to define. Empty and unreferenced in every database.
DROP TABLE IF EXISTS execution_results;
DROP TABLE IF EXISTS execution_runs;

-- A saved selection of flows and standalone tests, run as one.
CREATE TABLE IF NOT EXISTS suites (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    -- JSON array of {"kind":"flow"|"test","id":"..."} in run order.
    -- NULL means every flow and test in the project, resolved at run time — the same
    -- rule fan-out uses for `rowIds`, so a flow added later is included without anyone
    -- reopening the suite. An empty array means none, and the run fails saying so.
    members TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- One row per press of Run, whether or not a suite was involved.
CREATE TABLE IF NOT EXISTS suite_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- NULL for an ad-hoc run of a single flow, which is most of them.
    suite_id TEXT REFERENCES suites(id) ON DELETE SET NULL,
    -- Denormalised on purpose: deleting a suite must not rewrite what its runs were
    -- called, and renaming one must not retitle history. Same reasoning as
    -- NodeResult.expected being recorded rather than looked up.
    suite_name TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    duration_ms INTEGER,
    total INTEGER NOT NULL DEFAULT 0,
    passed INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    environment_name TEXT,
    error_message TEXT
);

-- One row per suite member: a flow, or a standalone test case.
CREATE TABLE IF NOT EXISTS flow_runs (
    id TEXT PRIMARY KEY,
    suite_run_id TEXT NOT NULL REFERENCES suite_runs(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    member_kind TEXT NOT NULL,
    -- SET NULL, never CASCADE: deleting a flow must not delete the record that it ran
    -- and failed. A history that edits itself when you tidy up is not a history.
    flow_id TEXT REFERENCES flows(id) ON DELETE SET NULL,
    test_case_id TEXT REFERENCES test_cases(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    duration_ms INTEGER,
    error_message TEXT
);

-- One row per node, plus one per dataset row of a fan-out node.
CREATE TABLE IF NOT EXISTS run_results (
    id TEXT PRIMARY KEY,
    flow_run_id TEXT NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
    -- Set on a dataset row, pointing at its node's aggregate. NULL on the node itself.
    parent_id TEXT REFERENCES run_results(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    node_id TEXT NOT NULL,
    node_label TEXT,
    test_case_id TEXT,
    test_case_name TEXT,
    status TEXT NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    expected TEXT,
    teardown INTEGER NOT NULL DEFAULT 0,
    row_index INTEGER,
    row_label TEXT,
    error_message TEXT,
    -- Redacted then zstd-packed (db/blob.rs). Opaque to SQL by design: everything the
    -- report tab groups, filters or charts is a plain column above. Only what is
    -- fetched whole for display is packed.
    request BLOB,
    response BLOB,
    logs BLOB,
    exports BLOB
);

CREATE INDEX IF NOT EXISTS idx_suites_project ON suites(project_id);
CREATE INDEX IF NOT EXISTS idx_suite_runs_project_started ON suite_runs(project_id, started_at);
CREATE INDEX IF NOT EXISTS idx_flow_runs_suite_run ON flow_runs(suite_run_id);
CREATE INDEX IF NOT EXISTS idx_run_results_flow_run ON run_results(flow_run_id);
CREATE INDEX IF NOT EXISTS idx_run_results_parent ON run_results(parent_id);
-- "how often has this case failed" — the first question the report tab asks.
CREATE INDEX IF NOT EXISTS idx_run_results_case_status ON run_results(test_case_id, status);
