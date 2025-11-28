-- Flows table
-- Run: sqlite3 satyanaash.db < migrations/003_flows.sql

CREATE TABLE IF NOT EXISTS flows (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    -- Graph data stored as JSON (nodes and edges)
    graph_data TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
    -- Canvas settings (zoom, pan, etc.)
    canvas_settings TEXT NOT NULL DEFAULT '{}',
    -- Optimistic locking version
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_flows_project_id ON flows(project_id);
