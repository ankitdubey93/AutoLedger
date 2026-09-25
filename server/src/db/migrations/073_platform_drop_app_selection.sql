-- 073_platform_drop_app_selection.sql
-- Phase 33 — one product. See docs/roadmap.md#phase-33-as-delivered.
--
-- LedgerCore, AP-Flow and StockLedger became modules of one product,
-- AutoLedger, so an organization no longer chooses which apps it uses.
-- organization_apps (migration 064) recorded that choice and nothing reads
-- it any more. The 'platform' onboarding row recorded "has picked its apps"
-- (the retired /welcome picker) and goes with it.
--
-- audit_logs rows about organization_apps are LEFT IN PLACE: they are the
-- CDC history of what happened (the same ruling 068 made). Only live state
-- is removed.
--
-- 064 stays on disk, unedited, per guardrails rule 13; on a fresh database
-- it still creates the table and this file drops it.

DROP TABLE IF EXISTS organization_apps;

DELETE FROM onboarding_states WHERE app_slug = 'platform';

-- Left behind by 068: dropping the forecaster_* tables removed their
-- triggers, not these trigger functions (migration 039). Nothing calls them.
DROP FUNCTION IF EXISTS reject_forecaster_budget_version_mutation();
DROP FUNCTION IF EXISTS reject_forecaster_frozen_budget_line_mutation();
