-- Test Cases table
-- Run: sqlite3 satyanaash.db < migrations/002_test_cases.sql

CREATE TABLE IF NOT EXISTS test_cases (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    -- BDD fields (documentation)
    given_condition TEXT,         -- Precondition/setup description
    when_action TEXT,             -- Action being tested
    then_expected TEXT,           -- Expected outcome description
    -- HTTP request definition
    method TEXT NOT NULL,         -- GET, POST, PUT, PATCH, DELETE
    endpoint TEXT NOT NULL,       -- URL with {{variable}} placeholders
    headers TEXT DEFAULT '{}',    -- JSON object
    payload TEXT,                 -- JSON with {{variable}} placeholders
    -- Variable extraction (declarative, JSONPath-based)
    exports TEXT DEFAULT '[]',    -- JSON: [{name, jsonPath}] - what to add to context
    -- Assertions (JS expression, evaluated in sandboxed runtime)
    assertion_script TEXT,        -- JS expression returning true/false
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_test_cases_project_id ON test_cases(project_id);
