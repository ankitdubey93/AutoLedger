-- 048_ap-flow_extraction_due_date.sql
-- Phase 19 — AP-Flow automated intake. See docs/roadmap.md#phase-19.
--
-- Adds due_date to ap_flow_extractions so a captured document can carry a
-- due date straight through to the bill it eventually posts as (migration
-- 049). ADD COLUMN ... with no DEFAULT and NULL-able adds no data and
-- rewrites nothing on a populated table.
--
-- ap_flow_extractions is update-immutable by trigger (migration 031,
-- reject_ap_flow_mutation on BEFORE UPDATE) — but that trigger fires on
-- UPDATE, never on ALTER TABLE ADD COLUMN, so this migration does not touch
-- it and does not need to.

ALTER TABLE ap_flow_extractions ADD COLUMN IF NOT EXISTS due_date DATE NULL;
