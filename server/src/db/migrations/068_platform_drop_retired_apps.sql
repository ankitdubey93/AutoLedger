-- 068_platform_drop_retired_apps.sql
-- Phase 29 — five apps retired. See docs/roadmap.md#phase-29-as-delivered.
--
-- TaxGuard AI, FP&A Engine, UnitEcon, BoardDeck Automator and ForecasterPro
-- are removed from the suite, along with the Phase 18 sandbox dataset. The
-- suite is LedgerCore, AP-Flow and StockLedger.
--
-- Migrations 033-047 are NOT deleted: guardrails rule 13 makes an applied
-- migration immutable, and migrate.ts checksums every one of them and
-- rejects a numbering gap. They stay on disk as history; this file undoes
-- what they built. On a fresh database those files still run first and this
-- one drops the result, which is why docker-compose.yml must keep the
-- pgvector image (044 still needs CREATE EXTENSION vector).
--
-- audit_logs, ai_model_calls, outbox_events and webhook_deliveries rows that
-- carry a retired app_slug are deliberately LEFT IN PLACE. They record what
-- genuinely happened; rewriting them would falsify the Phase 5 CDC trail.
-- organization_apps, onboarding_states and document_links rows are live
-- state, not history, so a row naming a vanished app is deleted below.

-- Children before parents. CASCADE is belt-and-braces: no surviving table
-- carries a REFERENCES into any of these.
DROP TABLE IF EXISTS fpa_assumptions CASCADE;
DROP TABLE IF EXISTS fpa_scenarios CASCADE;
DROP TABLE IF EXISTS fpa_models CASCADE;

DROP TABLE IF EXISTS forecaster_budget_lines CASCADE;
DROP TABLE IF EXISTS forecaster_budget_versions CASCADE;
DROP TABLE IF EXISTS forecaster_forecast_lines CASCADE;
DROP TABLE IF EXISTS forecaster_headcount_roles CASCADE;
DROP TABLE IF EXISTS forecaster_driver_values CASCADE;
DROP TABLE IF EXISTS forecaster_drivers CASCADE;
DROP TABLE IF EXISTS forecaster_plans CASCADE;

DROP TABLE IF EXISTS unitecon_acquisition_accounts CASCADE;
DROP TABLE IF EXISTS unitecon_product_lines CASCADE;
DROP TABLE IF EXISTS unitecon_settings CASCADE;

DROP TABLE IF EXISTS boarddeck_close_checks CASCADE;
DROP TABLE IF EXISTS boarddeck_decks CASCADE;
DROP TABLE IF EXISTS boarddeck_close_runs CASCADE;

DROP TABLE IF EXISTS taxguard_questions CASCADE;
DROP TABLE IF EXISTS taxguard_chunks CASCADE;
DROP TABLE IF EXISTS taxguard_corpus_documents CASCADE;

DROP TABLE IF EXISTS sandbox_datasets CASCADE;

-- Live state naming an app that no longer exists.
DELETE FROM organization_apps
 WHERE app_slug IN ('taxguard', 'fpa-engine', 'unitecon', 'boarddeck', 'forecaster');

DELETE FROM onboarding_states
 WHERE app_slug IN ('taxguard', 'fpa-engine', 'unitecon', 'boarddeck', 'forecaster');

-- No retired app created a vault link, so this matches zero rows today.
-- It is here because app_slug carries no REFERENCES (migration 030), so a
-- stray row would otherwise outlive the app forever.
DELETE FROM document_links
 WHERE app_slug IN ('taxguard', 'fpa-engine', 'unitecon', 'boarddeck', 'forecaster');

-- Only taxguard_chunks used it. Not CASCADE: if a dependent object survives,
-- this must fail loudly rather than drop something unplanned.
DROP EXTENSION IF EXISTS vector;
