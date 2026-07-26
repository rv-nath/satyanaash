-- Data-driven testing: an optional table of input rows per test case
-- Stored as JSON text, shape:
--   {"columns":["email"],"rows":[{"id","name","values","assertion"}]}
-- Nullable with no DEFAULT, so pre-existing rows read back as NULL
-- NOTE keep this file free of semicolons in comments, the migration runner
-- splits statements naively on the semicolon character
ALTER TABLE test_cases ADD COLUMN dataset TEXT;
