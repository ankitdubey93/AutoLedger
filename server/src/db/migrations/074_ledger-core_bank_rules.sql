-- 074_ledger-core_bank_rules.sql
-- Phase 34a — bank rules: a saved pattern ("memo contains STRIPE FEE, post to
-- 6600 Bank Fees") settles matching bank lines on import by posting a
-- journal entry through the existing Phase 6.1 post-journal path
-- (bankMatchService.postJournalForTransactionOnClient), instead of a human
-- doing it by hand every time the same recurring fee lands. See
-- plans/phase-34-automation-rules.md and docs/schema.md.
--
-- This is the same "no counterpart document, settle by journal" shape 057
-- introduced for a manual post-journal action; a rule is just what decides
-- which account and description to use, automatically. matched_rule_id is
-- therefore a *third* thing reject_bank_transaction_mutation() (019, then
-- 057) must exempt from its "only the match state may change" diff, which is
-- why that carve-out list keeps growing one column at a time as Phase 6.1
-- gains new settlement machinery.

CREATE TABLE IF NOT EXISTS bank_rules (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name               TEXT NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 80),
  priority           INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 10000),
  direction          TEXT NOT NULL DEFAULT 'ANY' CHECK (direction IN ('IN', 'OUT', 'ANY')),
  memo_contains      TEXT NOT NULL CHECK (length(btrim(memo_contains)) > 0 AND length(memo_contains) <= 100),
  amount_min_cents   BIGINT NULL CHECK (amount_min_cents IS NULL OR amount_min_cents > 0),
  amount_max_cents   BIGINT NULL CHECK (amount_max_cents IS NULL OR amount_max_cents > 0),
  bank_account_id    UUID NULL,
  target_account_id  UUID NOT NULL,
  description        TEXT NULL CHECK (description IS NULL OR (length(btrim(description)) > 0 AND length(description) <= 200)),
  is_active          BOOLEAN NOT NULL DEFAULT true,
  created_by         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_bank_rules_org_id_id UNIQUE (org_id, id),
  CONSTRAINT chk_bank_rules_amount_range CHECK (
    amount_min_cents IS NULL OR amount_max_cents IS NULL OR amount_min_cents <= amount_max_cents),
  CONSTRAINT fk_bank_rules_bank_account FOREIGN KEY (org_id, bank_account_id)
    REFERENCES accounts (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_bank_rules_target_account FOREIGN KEY (org_id, target_account_id)
    REFERENCES accounts (org_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_bank_rules_org_active ON bank_rules (org_id, priority) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_bank_rules_bank_account ON bank_rules (bank_account_id);
CREATE INDEX IF NOT EXISTS idx_bank_rules_target_account ON bank_rules (target_account_id);
CREATE INDEX IF NOT EXISTS idx_bank_rules_created_by ON bank_rules (created_by);
CREATE OR REPLACE TRIGGER trg_bank_rules_updated_at BEFORE UPDATE ON bank_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_bank_rules_audit AFTER INSERT OR UPDATE OR DELETE ON bank_rules
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS matched_rule_id UUID;
ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS fk_bank_txn_rule;
ALTER TABLE bank_transactions ADD CONSTRAINT fk_bank_txn_rule
  FOREIGN KEY (org_id, matched_rule_id) REFERENCES bank_rules (org_id, id) ON DELETE RESTRICT;
ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS chk_bank_txn_rule_needs_journal;
ALTER TABLE bank_transactions ADD CONSTRAINT chk_bank_txn_rule_needs_journal
  CHECK (matched_rule_id IS NULL OR matched_journal_entry_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_bank_txn_rule ON bank_transactions (matched_rule_id);

-- reject_bank_transaction_mutation() (019, then 057) must also exempt the
-- new column from its "only the match state may change" diff, or the
-- trigger it backs would reject the very UPDATE applyRulesOnClient performs
-- when it records which rule settled a line.
CREATE OR REPLACE FUNCTION reject_bank_transaction_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Bank transaction % is a record of fact and cannot be deleted', OLD.id
      USING ERRCODE = '0A000';
  END IF;

  IF to_jsonb(NEW) - 'status' - 'matched_payment_id' - 'matched_journal_entry_id' - 'matched_rule_id' - 'matched_at' - 'matched_by' - 'updated_at'
     IS DISTINCT FROM
     to_jsonb(OLD) - 'status' - 'matched_payment_id' - 'matched_journal_entry_id' - 'matched_rule_id' - 'matched_at' - 'matched_by' - 'updated_at' THEN
    RAISE EXCEPTION 'Bank transaction % may only change its match state', OLD.id
      USING ERRCODE = '0A000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- CREATE OR REPLACE FUNCTION is enough — the existing trigger
-- (trg_bank_transactions_immutable, 019) already points at this function by
-- name and does not need to be re-created.
