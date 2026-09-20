-- 057_ledger-core_bank_line_journal.sql
-- Phase 6.1 — a bank line with no counterpart document (a bank fee, interest,
-- an opening capital deposit) can now be settled by posting a journal entry
-- directly, not only by matching to an invoice or bill. See
-- docs/ledger-core.md and study/architecture/fuzzy-matching-and-confidence-scoring.md.
--
-- Until now `chk_bank_txn_matched_fields` (019) hard-coded the only
-- settlement shape a MATCHED line could have: a payment. This migration
-- gives a MATCHED line a second, mutually exclusive shape — a journal
-- entry — rather than adding a new status, so BANK_TRANSACTION_TRANSITIONS
-- (types/ledger-core.ts) is untouched: this is still an UNMATCHED -> MATCHED
-- transition, just settled a different way.
--
-- A table CHECK constraint has no `ADD CONSTRAINT IF NOT EXISTS`, so the
-- idempotent idiom (matching 056's own use of it) is DROP CONSTRAINT IF
-- EXISTS followed by ADD CONSTRAINT.

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS matched_journal_entry_id UUID;

ALTER TABLE bank_transactions
  DROP CONSTRAINT IF EXISTS chk_bank_txn_matched_fields;

-- (matched_payment_id IS NULL) <> (matched_journal_entry_id IS NULL) is XOR:
-- a MATCHED row has exactly one of the two settlement targets set, never
-- both and never neither.
ALTER TABLE bank_transactions
  ADD CONSTRAINT chk_bank_txn_matched_fields CHECK (
    (status = 'MATCHED'
       AND matched_at IS NOT NULL
       AND matched_by IS NOT NULL
       AND (matched_payment_id IS NULL) <> (matched_journal_entry_id IS NULL))
    OR
    (status <> 'MATCHED'
       AND matched_payment_id IS NULL
       AND matched_journal_entry_id IS NULL
       AND matched_at IS NULL
       AND matched_by IS NULL)
  );

ALTER TABLE bank_transactions
  DROP CONSTRAINT IF EXISTS fk_bank_txn_journal_entry;

ALTER TABLE bank_transactions
  ADD CONSTRAINT fk_bank_txn_journal_entry
    FOREIGN KEY (org_id, matched_journal_entry_id)
    REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_bank_txn_journal_entry ON bank_transactions (matched_journal_entry_id);

-- reject_bank_transaction_mutation() (019) must also exempt the new column
-- from its "only the match state may change" diff, or the trigger it backs
-- would reject the very UPDATE this migration's new feature performs.
CREATE OR REPLACE FUNCTION reject_bank_transaction_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Bank transaction % is a record of fact and cannot be deleted', OLD.id
      USING ERRCODE = '0A000';
  END IF;

  IF to_jsonb(NEW) - 'status' - 'matched_payment_id' - 'matched_journal_entry_id' - 'matched_at' - 'matched_by' - 'updated_at'
     IS DISTINCT FROM
     to_jsonb(OLD) - 'status' - 'matched_payment_id' - 'matched_journal_entry_id' - 'matched_at' - 'matched_by' - 'updated_at' THEN
    RAISE EXCEPTION 'Bank transaction % may only change its match state', OLD.id
      USING ERRCODE = '0A000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- CREATE OR REPLACE FUNCTION is enough — the existing triggers
-- (trg_bank_transactions_immutable, 019) already point at this function by
-- name and do not need to be re-created.
