-- 005_ledger-core_settings.sql
-- Phase 3.5 — LedgerCore onboarding & settings. See docs/schema.md and
-- docs/roadmap.md#phase-35-as-delivered.
--
-- Every statement is idempotent (IF NOT EXISTS / a pg_constraint guard) so the
-- file can be replayed against a database that already has part of it. The
-- runner applies each file inside a single transaction, and PostgreSQL has
-- transactional DDL, so a failure anywhere below leaves the database
-- completely untouched.

-- ------------------------------------------------------- composite-FK support

-- ALTER TABLE ADD CONSTRAINT has no IF NOT EXISTS, and migrations.test.ts
-- deletes schema_migrations and re-executes every file against a populated
-- database — this guard is what makes that replay succeed the second time.
--
-- The constraint itself exists only so ledger_settings.cash_account_id below
-- can carry a COMPOSITE foreign key (org_id, cash_account_id) -> accounts
-- (org_id, id). A single-column FK on account id alone would let one
-- organization's settings point at another tenant's account, caught only by a
-- service-level check rather than the database (guardrails rule 1).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ux_accounts_org_id_id') THEN
    ALTER TABLE accounts ADD CONSTRAINT ux_accounts_org_id_id UNIQUE (org_id, id);
  END IF;
END $$;

-- ---------------------------------------------------------------- ledger_settings

-- One row per organization, keyed by org_id itself rather than a separate id:
-- there is exactly one settings row per org, and org_id-as-PK indexes the
-- scope column for free.
--
-- Deliberately NO backfill and NO seed row. The absence of a row IS the
-- "onboarding not yet completed" signal, which is the correct state for every
-- organization that predates this migration. This is also why onboarded_at is
-- NOT NULL: the row only ever exists once onboarding actually completed.
CREATE TABLE IF NOT EXISTS ledger_settings (
  org_id                  UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,

  legal_name              TEXT,

  -- Capped at 28: a fiscal year start date must exist in every possible month
  -- (Feb has as few as 28 days), so day 29-31 would be a start date some
  -- Februaries do not have.
  fiscal_year_start_month SMALLINT NOT NULL CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  fiscal_year_start_day   SMALLINT NOT NULL DEFAULT 1 CHECK (fiscal_year_start_day BETWEEN 1 AND 28),

  books_start_date        DATE NOT NULL,
  industry                TEXT,
  timezone                TEXT NOT NULL DEFAULT 'UTC',

  -- Nullable: an org may not have designated a cash account yet, and the
  -- dashboard's cash tile renders `null` rather than guessing one by name.
  cash_account_id         UUID,

  onboarded_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The tenant boundary enforced by the database, not only by the service.
  -- ON DELETE RESTRICT, not SET NULL: a composite FK's SET NULL would null
  -- EVERY column in the key, including org_id, which is this table's NOT NULL
  -- primary key. Accounts are never actually deleted (retired via
  -- is_active = false instead), so RESTRICT never fires in practice.
  --
  -- MATCH SIMPLE (the default) means a NULL cash_account_id satisfies the
  -- constraint without checking it at all — exactly the wanted behaviour for
  -- "no cash account configured yet".
  CONSTRAINT fk_ledger_settings_cash_account
    FOREIGN KEY (org_id, cash_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT
);

-- Rule 8: index every FK used in a join.
CREATE INDEX IF NOT EXISTS idx_ledger_settings_cash_account ON ledger_settings (cash_account_id);

-- ------------------------------------------------------------------- triggers

-- Reuses the shared function from 001 rather than defining a second one
-- (docs/schema.md#migration-rules).
CREATE OR REPLACE TRIGGER trg_ledger_settings_updated_at
  BEFORE UPDATE ON ledger_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
