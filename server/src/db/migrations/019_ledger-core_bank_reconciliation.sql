-- 019_ledger-core_bank_reconciliation.sql
-- Phase 6 — LedgerCore bank reconciliation. See docs/schema.md and
-- docs/ledger-core.md#phase-6--bank-reconciliation.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.
--
-- Three tables: one row per imported CSV statement (bank_statement_imports),
-- one row per parsed transaction line (bank_transactions), and up to five
-- scored candidate matches per unmatched line (bank_match_suggestions).
-- Re-importing the same statement is idempotent via
-- UNIQUE (org_id, dedupe_hash) on bank_transactions — see
-- study/postgresql/idempotent-ingestion-and-dedupe-hashes.md.

-- ------------------------------------------------- bank_statement_imports

CREATE TABLE IF NOT EXISTS bank_statement_imports (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  account_id            UUID NOT NULL,

  file_name             TEXT NOT NULL CHECK (length(btrim(file_name)) > 0 AND length(file_name) <= 200),
  date_format           TEXT NOT NULL CHECK (date_format IN ('ISO', 'DMY', 'MDY')),
  delimiter             TEXT NOT NULL CHECK (length(delimiter) = 1),

  row_count             INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  imported_count        INTEGER NOT NULL DEFAULT 0 CHECK (imported_count >= 0),
  duplicate_count       INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),

  earliest_date         DATE,
  latest_date           DATE,

  closing_balance_cents BIGINT,
  closing_balance_on    DATE,

  created_by            UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_bank_statement_imports_org_id_id UNIQUE (org_id, id),
  CONSTRAINT chk_bank_imports_date_range CHECK (
    earliest_date IS NULL OR latest_date IS NULL OR earliest_date <= latest_date
  ),
  CONSTRAINT chk_bank_imports_closing_pair CHECK (
    (closing_balance_cents IS NULL AND closing_balance_on IS NULL) OR
    (closing_balance_cents IS NOT NULL AND closing_balance_on IS NOT NULL)
  ),
  CONSTRAINT chk_bank_imports_counts CHECK (imported_count + duplicate_count <= row_count),
  CONSTRAINT fk_bank_imports_account
    FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_bank_imports_org_created ON bank_statement_imports (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_imports_account     ON bank_statement_imports (account_id);
CREATE INDEX IF NOT EXISTS idx_bank_imports_created_by  ON bank_statement_imports (created_by);

-- ------------------------------------------------------- bank_transactions

CREATE TABLE IF NOT EXISTS bank_transactions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  import_id          UUID NOT NULL,
  account_id         UUID NOT NULL,

  txn_date           DATE NOT NULL,
  description        TEXT NOT NULL CHECK (length(description) <= 500),
  external_reference TEXT CHECK (external_reference IS NULL OR length(external_reference) <= 100),
  currency_code      CHAR(3) NOT NULL,
  -- Signed: > 0 money in, < 0 money out. Never 0 — a zero-amount row is
  -- rejected at import time (bankImportService), not stored.
  amount_cents       BIGINT NOT NULL CHECK (amount_cents <> 0),

  dedupe_hash        CHAR(64) NOT NULL,

  status             TEXT NOT NULL DEFAULT 'UNMATCHED'
                     CHECK (status IN ('UNMATCHED', 'MATCHED', 'IGNORED')),
  matched_payment_id UUID,
  matched_at         TIMESTAMPTZ,
  matched_by         UUID REFERENCES users(id) ON DELETE RESTRICT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_bank_transactions_org_id_id UNIQUE (org_id, id),
  -- Idempotent re-import: the same statement uploaded twice yields one set
  -- of rows. The hash itself folds in an occurrence ordinal for genuinely
  -- duplicate lines within one file — see bankImportService.
  CONSTRAINT ux_bank_transactions_dedupe UNIQUE (org_id, dedupe_hash),
  CONSTRAINT chk_bank_txn_matched_fields CHECK (
    (status = 'MATCHED'  AND matched_payment_id IS NOT NULL AND matched_at IS NOT NULL AND matched_by IS NOT NULL) OR
    (status <> 'MATCHED' AND matched_payment_id IS NULL     AND matched_at IS NULL     AND matched_by IS NULL)
  ),
  CONSTRAINT fk_bank_txn_import
    FOREIGN KEY (org_id, import_id) REFERENCES bank_statement_imports (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_bank_txn_account
    FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_bank_txn_payment
    FOREIGN KEY (org_id, matched_payment_id) REFERENCES payments (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_bank_txn_org_status_date ON bank_transactions (org_id, status, txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_bank_txn_org_account     ON bank_transactions (org_id, account_id, txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_bank_txn_import          ON bank_transactions (import_id);
CREATE INDEX IF NOT EXISTS idx_bank_txn_payment         ON bank_transactions (matched_payment_id);
CREATE INDEX IF NOT EXISTS idx_bank_txn_matched_by      ON bank_transactions (matched_by);

-- --------------------------------------------------- bank_match_suggestions

CREATE TABLE IF NOT EXISTS bank_match_suggestions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bank_transaction_id UUID NOT NULL,
  target_type         TEXT NOT NULL CHECK (target_type IN ('invoice', 'bill')),
  invoice_id          UUID,
  bill_id             UUID,
  score               INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
  score_breakdown     JSONB NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_bank_suggestion_one_target CHECK (
    (target_type = 'invoice' AND invoice_id IS NOT NULL AND bill_id IS NULL) OR
    (target_type = 'bill'    AND bill_id    IS NOT NULL AND invoice_id IS NULL)
  ),
  CONSTRAINT ux_bank_suggestion_invoice UNIQUE (bank_transaction_id, invoice_id),
  CONSTRAINT ux_bank_suggestion_bill    UNIQUE (bank_transaction_id, bill_id),
  CONSTRAINT fk_bank_suggestion_txn
    FOREIGN KEY (org_id, bank_transaction_id) REFERENCES bank_transactions (org_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_bank_suggestion_invoice
    FOREIGN KEY (org_id, invoice_id) REFERENCES invoices (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_bank_suggestion_bill
    FOREIGN KEY (org_id, bill_id) REFERENCES bills (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_bank_suggestion_txn_score ON bank_match_suggestions (bank_transaction_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_bank_suggestion_invoice   ON bank_match_suggestions (invoice_id);
CREATE INDEX IF NOT EXISTS idx_bank_suggestion_bill      ON bank_match_suggestions (bill_id);

-- ------------------------------------------------------------- immutability

-- A bank transaction is a record of fact from a downloaded statement — it is
-- never deleted, and the only fields that may ever change are its match
-- state, mirroring reject_payment_mutation() (014) and
-- reject_bill_mutation-style carve-outs elsewhere in this schema.
CREATE OR REPLACE FUNCTION reject_bank_transaction_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Bank transaction % is a record of fact and cannot be deleted', OLD.id
      USING ERRCODE = '0A000';
  END IF;

  IF to_jsonb(NEW) - 'status' - 'matched_payment_id' - 'matched_at' - 'matched_by' - 'updated_at'
     IS DISTINCT FROM
     to_jsonb(OLD) - 'status' - 'matched_payment_id' - 'matched_at' - 'matched_by' - 'updated_at' THEN
    RAISE EXCEPTION 'Bank transaction % may only change its match state', OLD.id
      USING ERRCODE = '0A000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Same-timing (BEFORE UPDATE) triggers fire alphabetically by name, so
-- trg_bank_transactions_immutable runs before trg_bank_transactions_updated_at
-- — which is exactly why the row-diff above excludes updated_at. Do not
-- rename either trigger; the ordering is load-bearing, mirroring
-- trg_payments_immutable / trg_payments_updated_at (014).
CREATE OR REPLACE TRIGGER trg_bank_transactions_immutable
  BEFORE UPDATE OR DELETE ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION reject_bank_transaction_mutation();

CREATE OR REPLACE TRIGGER trg_bank_transactions_updated_at
  BEFORE UPDATE ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_bank_statement_imports_updated_at
  BEFORE UPDATE ON bank_statement_imports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------------- audit

-- Phase 5's audit_row_change() covers both record tables. bank_match_suggestions
-- is deliberately NOT audited: it is derived data, deleted and regenerated
-- wholesale on every rescore, so auditing it would write up to five rows per
-- rescore with no compliance value — the same reasoning 018 applies to
-- schema_migrations.
CREATE OR REPLACE TRIGGER trg_bank_statement_imports_audit
  AFTER INSERT OR UPDATE OR DELETE ON bank_statement_imports
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

CREATE OR REPLACE TRIGGER trg_bank_transactions_audit
  AFTER INSERT OR UPDATE OR DELETE ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');
