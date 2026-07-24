-- Test groups: single-level user-created buckets for organizing test cases
CREATE TABLE IF NOT EXISTS test_groups (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Nullable group_id on test_cases. A NULL value means Ungrouped.
-- Idempotent via the duplicate-column guard in pool.rs.
ALTER TABLE test_cases ADD COLUMN group_id TEXT;
