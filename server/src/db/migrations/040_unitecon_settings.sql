-- 040_unitecon_settings.sql
-- Phase 14 — UnitEcon: per-organization unit-economics configuration. See
-- docs/unitecon.md and docs/roadmap.md#phase-14.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.
--
-- TWO DELIBERATE RULINGS:
--  1. No REFERENCES accounts on unitecon_acquisition_accounts.account_id —
--     rules 8 and 16 collide, 16 wins (migrations 032, 034, 037, 038, 039).
--     settingsService validates the id through accountService.getAccountById,
--     which 404s on another organization's account.
--  2. No status column and no immutability trigger anywhere in this phase.
--     UnitEcon posts nothing to the general ledger, so rule 6 does not apply
--     and PATCH is correct — the identical ruling fpa_models (033) and
--     forecaster_plans (035) carry.

CREATE TABLE IF NOT EXISTS unitecon_settings (
  org_id          UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  -- Basis points — never a float. 7000 means 70.0%.
  gross_margin_bps INTEGER NOT NULL DEFAULT 7000
    CHECK (gross_margin_bps BETWEEN 0 AND 10000),
  created_by      UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_unitecon_settings_created_by
  ON unitecon_settings (created_by);

CREATE TABLE IF NOT EXISTS unitecon_acquisition_accounts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- No REFERENCES accounts — see ruling 1 in this file's header.
  account_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_unitecon_acquisition_accounts UNIQUE (org_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_unitecon_acquisition_accounts_org
  ON unitecon_acquisition_accounts (org_id, account_id);

CREATE OR REPLACE TRIGGER trg_unitecon_settings_updated
  BEFORE UPDATE ON unitecon_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_unitecon_settings_audit
  AFTER INSERT OR UPDATE OR DELETE ON unitecon_settings
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('unitecon');

CREATE OR REPLACE TRIGGER trg_unitecon_acquisition_accounts_audit
  AFTER INSERT OR UPDATE OR DELETE ON unitecon_acquisition_accounts
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('unitecon');
