-- 012_ledger-core_ap_posting_accounts.sql
-- Phase 3.9 — LedgerCore accounts payable posting accounts on ledger_settings.
-- See docs/schema.md and docs/ledger-core.md#phase-39--accounts-payable.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.

ALTER TABLE ledger_settings ADD COLUMN IF NOT EXISTS payable_account_id         UUID;
ALTER TABLE ledger_settings ADD COLUMN IF NOT EXISTS tax_input_account_id       UUID;
ALTER TABLE ledger_settings ADD COLUMN IF NOT EXISTS default_expense_account_id UUID;

-- ALTER TABLE ADD CONSTRAINT has no IF NOT EXISTS, so each gets its own
-- pg_constraint guard — the same idiom 005 and 007 use, required so this file
-- can be replayed against a database that already has part of it
-- (migrations.test.ts deletes schema_migrations and re-executes every file
-- against a populated database).
--
-- Composite FKs, same reasoning as ledger_invoice_settings' three FKs (007):
-- a single-column FK would let one organization's settings point at another
-- tenant's account. ON DELETE RESTRICT because accounts are never actually
-- deleted (retired via is_active = false), and a composite SET NULL would
-- null org_id, this table's primary key.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ledger_settings_payable_account') THEN
    ALTER TABLE ledger_settings ADD CONSTRAINT fk_ledger_settings_payable_account
      FOREIGN KEY (org_id, payable_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ledger_settings_tax_input_account') THEN
    ALTER TABLE ledger_settings ADD CONSTRAINT fk_ledger_settings_tax_input_account
      FOREIGN KEY (org_id, tax_input_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ledger_settings_default_expense_account') THEN
    ALTER TABLE ledger_settings ADD CONSTRAINT fk_ledger_settings_default_expense_account
      FOREIGN KEY (org_id, default_expense_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT;
  END IF;
END $$;

-- Rule 8: index every FK used in a join.
CREATE INDEX IF NOT EXISTS idx_ledger_settings_payable_account ON ledger_settings (payable_account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_settings_tax_input_account ON ledger_settings (tax_input_account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_settings_default_expense_account ON ledger_settings (default_expense_account_id);
