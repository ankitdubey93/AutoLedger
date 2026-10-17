-- Phase 46e — soft delete of an unreconciled bank statement line.
-- A line is never hard-deleted (reject_bank_transaction_mutation still refuses
-- DELETE); it moves to status 'DELETED' with who/when/why, and can be restored.
-- The dedupe UNIQUE (org_id, dedupe_hash) is untouched, so a deleted line still
-- blocks re-import of the same statement row (user decision 4).

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS deleted_by UUID NULL,
  ADD COLUMN IF NOT EXISTS delete_reason TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'bank_transactions'::regclass AND conname = 'fk_bank_txn_deleted_by'
  ) THEN
    ALTER TABLE bank_transactions
      ADD CONSTRAINT fk_bank_txn_deleted_by
      FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bank_txn_deleted_by ON bank_transactions (deleted_by);

-- The status CHECK was created inline in 019 and is named
-- bank_transactions_status_check; chk_bank_txn_status is dropped too so the
-- migration replays.
ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_status_check;
ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS chk_bank_txn_status;
ALTER TABLE bank_transactions
  ADD CONSTRAINT chk_bank_txn_status
  CHECK (status IN ('UNMATCHED','MATCHED','IGNORED','DELETED'));

ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS chk_bank_txn_deleted_fields;
ALTER TABLE bank_transactions
  ADD CONSTRAINT chk_bank_txn_deleted_fields
  CHECK (
    (status = 'DELETED') = (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
    AND (status = 'DELETED' OR delete_reason IS NULL)
  );

-- 074's body, with the three delete columns added to both exempt lists.
CREATE OR REPLACE FUNCTION reject_bank_transaction_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Bank transaction % is a record of fact and cannot be deleted', OLD.id
      USING ERRCODE = '0A000';
  END IF;

  IF to_jsonb(NEW) - 'status' - 'matched_payment_id' - 'matched_journal_entry_id' - 'matched_rule_id' - 'matched_at' - 'matched_by' - 'updated_at' - 'deleted_at' - 'deleted_by' - 'delete_reason'
     IS DISTINCT FROM
     to_jsonb(OLD) - 'status' - 'matched_payment_id' - 'matched_journal_entry_id' - 'matched_rule_id' - 'matched_at' - 'matched_by' - 'updated_at' - 'deleted_at' - 'deleted_by' - 'delete_reason' THEN
    RAISE EXCEPTION 'Bank transaction % may only change its match state', OLD.id
      USING ERRCODE = '0A000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
