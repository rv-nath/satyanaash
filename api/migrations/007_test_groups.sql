-- Test groups: single-level, user-created buckets for organizing test cases
CREATE TABLE IF NOT EXISTS test_groups (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Nullable group_id on test_cases; NULL = Ungrouped (idempotent via pool.rs guard)
ALTER TABLE test_cases ADD COLUMN group_id TEXT;
