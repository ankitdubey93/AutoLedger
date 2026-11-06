-- Phase 49c — GST on money that moves without a document: bank-line journals,
-- bank rules and manual journals.
--
-- ledger_lines say nothing about tax, and a posted one is immutable, so the
-- detail sits beside the entry. Insert-only. A reversal gets no row of its own:
-- the BAS reads journal_entries.reverses_entry_id and produces the opposite
-- event on the reversal's date, so the two can never disagree.
CREATE TABLE IF NOT EXISTS journal_tax_details (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  journal_entry_id  UUID NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  tax_code          TEXT NOT NULL,
  tax_rate_bp       INTEGER NOT NULL CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  -- +1 for the code's normal side (a sale credited, a purchase debited); -1 for
  -- a refund the other way. Amounts stay positive, as on document lines.
  sign              SMALLINT NOT NULL CHECK (sign IN (1, -1)),
  net_cents         BIGINT NOT NULL CHECK (net_cents >= 0),
  tax_cents         BIGINT NOT NULL CHECK (tax_cents >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_journal_tax_details_code CHECK (tax_code IN (
    'S_GST','S_EXPORT','S_FREE','S_INPUT_TAXED','S_EXCLUDED',
    'P_GST','P_CAP_GST','P_FREE','P_CAP_FREE','P_INPUT_TAXED','P_PRIVATE','P_EXCLUDED'
  ))
);

CREATE INDEX IF NOT EXISTS idx_journal_tax_details_org_entry ON journal_tax_details (org_id, journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_tax_details_entry ON journal_tax_details (journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_tax_details_account ON journal_tax_details (account_id);

CREATE OR REPLACE TRIGGER trg_journal_tax_details_audit
  AFTER INSERT OR UPDATE OR DELETE ON journal_tax_details
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

ALTER TABLE manual_journal_lines ADD COLUMN IF NOT EXISTS tax_code TEXT NULL;
ALTER TABLE bank_rules ADD COLUMN IF NOT EXISTS tax_code TEXT NULL;

DO $$
DECLARE
  codes CONSTANT TEXT := $c$'S_GST','S_EXPORT','S_FREE','S_INPUT_TAXED','S_EXCLUDED','P_GST','P_CAP_GST','P_FREE','P_CAP_FREE','P_INPUT_TAXED','P_PRIVATE','P_EXCLUDED'$c$;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_manual_journal_lines_tax_code') THEN
    EXECUTE format('ALTER TABLE manual_journal_lines ADD CONSTRAINT chk_manual_journal_lines_tax_code CHECK (tax_code IS NULL OR tax_code IN (%s))', codes);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bank_rules_tax_code') THEN
    EXECUTE format('ALTER TABLE bank_rules ADD CONSTRAINT chk_bank_rules_tax_code CHECK (tax_code IS NULL OR tax_code IN (%s))', codes);
  END IF;
END $$;
