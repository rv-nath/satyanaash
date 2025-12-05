-- Migration: Merge canvas_settings into graph_data
-- This merges the separate canvas_settings column into the graph_data JSON

-- Update existing rows to embed canvas_settings into graph_data
UPDATE flows
SET graph_data = json_set(
    graph_data,
    '$.canvas_settings',
    json(canvas_settings)
)
WHERE canvas_settings IS NOT NULL AND canvas_settings != '{}';

-- Note: We keep the canvas_settings column for backwards compatibility
-- but it will no longer be used. Can be dropped in a future migration.
