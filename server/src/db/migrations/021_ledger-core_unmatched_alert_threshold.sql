-- 021_ledger-core_unmatched_alert_threshold.sql
-- Phase 7 — the configurable threshold behind the bank.large_unmatched
-- webhook event. See docs/ledger-core.md#webhooks-for-financial-events--phase-7.
--
-- DEFAULT 0 means DISABLED, and every existing organization is disabled by
-- default — no backfill, and nobody starts receiving alerts because this
-- migration ran.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere
-- below leaves the database untouched.

ALTER TABLE ledger_settings
  ADD COLUMN IF NOT EXISTS unmatched_alert_threshold_cents BIGINT NOT NULL DEFAULT 0;

-- ALTER TABLE ADD CONSTRAINT has no IF NOT EXISTS, so DROP first — the same
-- idiom 005, 007 and 012 use, required so this file can be replayed against
-- a database that already has part of it.
ALTER TABLE ledger_settings
  DROP CONSTRAINT IF EXISTS chk_ledger_settings_unmatched_threshold;
ALTER TABLE ledger_settings
  ADD CONSTRAINT chk_ledger_settings_unmatched_threshold
  CHECK (unmatched_alert_threshold_cents >= 0);
