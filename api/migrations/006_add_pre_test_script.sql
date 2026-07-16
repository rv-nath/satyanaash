-- Add pre_test_script column to test_cases (idempotent)
-- Rhai script executed before HTTP request, can set variables via SAT.vars
ALTER TABLE test_cases ADD COLUMN pre_test_script TEXT;
