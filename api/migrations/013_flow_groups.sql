-- Flow groups: single-level user-created buckets for organizing flows.
--
-- Beside `test_groups` rather than shared with it. A bucket holding both a flow and the tests
-- it uses sounds tidier, but then the tests view and the flows view compete over one set of
-- names and every group has two kinds of child to render and count.
--
-- Note the collision this inherits: `node_type = 'group'` on the canvas already means a node
-- that runs another flow. That node is the misnomer -- it is a sub-flow -- and renaming it
-- means migrating graph_data JSON, so it is left alone here. In code, a bucket of flows is
-- always FlowGroup / flow_groups.
CREATE TABLE IF NOT EXISTS flow_groups (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Nullable group_id on flows. A NULL value means Ungrouped, so every flow that exists today
-- keeps behaving exactly as it does with no backfill.
--
-- Idempotent via the duplicate-column guard in pool.rs.
ALTER TABLE flows ADD COLUMN group_id TEXT;
