-- 097_ledger-core_manual_journals.sql
-- Phase 44 — Xero-style Manual Journals.
--
-- A manual journal becomes a DOCUMENT (DRAFT / TEMPLATE / POSTED / VOIDED) that
-- owns an immutable GL posting, exactly as an invoice owns its journal entry
-- (009): the draft and its lines are editable, the posting in journal_entries /
-- ledger_lines is insert-only, and a void posts a reversal. TEMPLATE is the
-- never-posted source of a repeating journal.
--
-- The bank / credit-card marker is a nullable COLUMN on accounts, not a sixth
-- account type (guardrails rule 12): BANK is an Asset, CREDIT_CARD a Liability.
--
-- The backfill wraps every existing manual / recurring / imported entry in a
-- manual_journals row. It is idempotent through NOT EXISTS on
-- manual_journals.journal_entry_id. Replaying the bank-flag UPDATE re-flags
-- account 1110 (acceptable: replay runs only on the test database).
--
-- Additive and idempotent throughout.

-- ----------------------------------------------------------- bank flag

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS bank_account_kind TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_accounts_bank_account_kind') THEN
    ALTER TABLE accounts
      ADD CONSTRAINT ck_accounts_bank_account_kind CHECK (
           bank_account_kind IS NULL
        OR (bank_account_kind = 'BANK'        AND type = 'Asset')
        OR (bank_account_kind = 'CREDIT_CARD' AND type = 'Liability'));
  END IF;
END $$;

UPDATE accounts a SET bank_account_kind = 'BANK'
 WHERE a.bank_account_kind IS NULL AND a.type = 'Asset' AND (
       a.code = '1110'
    OR EXISTS (SELECT 1 FROM bank_statement_imports i WHERE i.org_id = a.org_id AND i.account_id = a.id)
    OR EXISTS (SELECT 1 FROM bank_transactions t WHERE t.org_id = a.org_id AND t.account_id = a.id)
    OR EXISTS (SELECT 1 FROM bank_rules r WHERE r.org_id = a.org_id AND r.bank_account_id = a.id)
    OR EXISTS (SELECT 1 FROM ledger_settings s WHERE s.org_id = a.org_id AND s.cash_account_id = a.id)
    OR EXISTS (SELECT 1 FROM payments p WHERE p.org_id = a.org_id AND p.cash_account_id = a.id));

UPDATE accounts a SET bank_account_kind = 'CREDIT_CARD'
 WHERE a.bank_account_kind IS NULL AND a.type = 'Liability' AND (
       EXISTS (SELECT 1 FROM bank_statement_imports i WHERE i.org_id = a.org_id AND i.account_id = a.id)
    OR EXISTS (SELECT 1 FROM bank_transactions t WHERE t.org_id = a.org_id AND t.account_id = a.id)
    OR EXISTS (SELECT 1 FROM bank_rules r WHERE r.org_id = a.org_id AND r.bank_account_id = a.id));

CREATE INDEX IF NOT EXISTS idx_accounts_org_bank_kind ON accounts (org_id) WHERE bank_account_kind IS NOT NULL;

-- ------------------------------------------------------ line description
-- ledger_lines is insert-only (reject_mutation); ADD COLUMN fires no row
-- trigger, and reject_mutation is left untouched.

ALTER TABLE ledger_lines ADD COLUMN IF NOT EXISTS description TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ledger_lines_description_length') THEN
    ALTER TABLE ledger_lines
      ADD CONSTRAINT ck_ledger_lines_description_length
      CHECK (description IS NULL OR char_length(description) <= 500);
  END IF;
END $$;

-- -------------------------------------------------------- manual_journals

CREATE TABLE IF NOT EXISTS manual_journals (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  status                 TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','TEMPLATE','POSTED','VOIDED')),
  origin                 TEXT NOT NULL DEFAULT 'MANUAL' CHECK (origin IN ('MANUAL','RECURRING','IMPORT')),
  narration              TEXT NOT NULL CHECK (length(btrim(narration)) > 0 AND char_length(narration) <= 500),
  narration_template     TEXT NULL CHECK (narration_template IS NULL OR char_length(narration_template) <= 500),
  entry_date             DATE NOT NULL,
  journal_entry_id       UUID NULL,
  void_journal_entry_id  UUID NULL,
  recurring_schedule_id  UUID NULL,
  posted_at              TIMESTAMPTZ NULL,
  voided_at              TIMESTAMPTZ NULL,
  created_by             UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_manual_journals_org_id_id UNIQUE (org_id, id),
  CONSTRAINT chk_manual_journals_posted_complete CHECK (
    status NOT IN ('POSTED','VOIDED') OR (journal_entry_id IS NOT NULL AND posted_at IS NOT NULL)),
  CONSTRAINT chk_manual_journals_unposted_has_no_entry CHECK (
    status NOT IN ('DRAFT','TEMPLATE') OR (journal_entry_id IS NULL AND posted_at IS NULL)),
  CONSTRAINT chk_manual_journals_voided_complete CHECK (
    (status = 'VOIDED') = (void_journal_entry_id IS NOT NULL AND voided_at IS NOT NULL)),
  CONSTRAINT chk_manual_journals_template_origin CHECK (status <> 'TEMPLATE' OR origin = 'MANUAL'),
  CONSTRAINT fk_manual_journals_journal_entry FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_manual_journals_void_journal_entry FOREIGN KEY (org_id, void_journal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_manual_journals_recurring_schedule FOREIGN KEY (org_id, recurring_schedule_id) REFERENCES recurring_schedules (org_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_manual_journals_journal_entry ON manual_journals (journal_entry_id) WHERE journal_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_manual_journals_org_status_date ON manual_journals (org_id, status, entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_manual_journals_void_journal_entry ON manual_journals (void_journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_manual_journals_recurring_schedule ON manual_journals (recurring_schedule_id);
CREATE INDEX IF NOT EXISTS idx_manual_journals_created_by ON manual_journals (created_by);

-- ---------------------------------------------------- manual_journal_lines
-- A draft line may have both sides zero and no account (a half-typed row).
-- Rule 7's "exactly one side" is enforced when the line is posted, by the
-- service and by ledger_lines' own CHECKs.

CREATE TABLE IF NOT EXISTS manual_journal_lines (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  manual_journal_id  UUID NOT NULL,
  line_number        SMALLINT NOT NULL CHECK (line_number > 0),
  account_id         UUID NULL,
  description        TEXT NULL CHECK (description IS NULL OR char_length(description) <= 500),
  debit_cents        BIGINT NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents       BIGINT NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_manual_journal_lines_line UNIQUE (manual_journal_id, line_number),
  CONSTRAINT chk_manual_journal_lines_one_side CHECK (NOT (debit_cents > 0 AND credit_cents > 0)),
  CONSTRAINT fk_manual_journal_lines_journal FOREIGN KEY (org_id, manual_journal_id) REFERENCES manual_journals (org_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_manual_journal_lines_account FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_manual_journal_lines_journal ON manual_journal_lines (manual_journal_id);
CREATE INDEX IF NOT EXISTS idx_manual_journal_lines_account ON manual_journal_lines (account_id);
CREATE INDEX IF NOT EXISTS idx_manual_journal_lines_org ON manual_journal_lines (org_id);

-- ---------------------------------------------------------------- triggers
-- Same shape as 009's reject_issued_invoice_mutation: a draft or template is
-- freely editable; a POSTED journal may only move to VOIDED, touching only the
-- void columns (rule 6).

CREATE OR REPLACE FUNCTION reject_posted_manual_journal_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN ('DRAFT','TEMPLATE') THEN
      RAISE EXCEPTION 'Manual journal % is % and cannot be deleted', OLD.id, OLD.status
        USING ERRCODE = '0A000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status IN ('DRAFT','TEMPLATE') THEN
    RETURN NEW;
  END IF;

  IF NOT (OLD.status = 'POSTED' AND NEW.status = 'VOIDED') THEN
    RAISE EXCEPTION 'Manual journal % is % and is immutable', OLD.id, OLD.status
      USING ERRCODE = '0A000';
  END IF;

  IF to_jsonb(NEW) - 'status' - 'void_journal_entry_id' - 'voided_at' - 'updated_at'
     IS DISTINCT FROM
     to_jsonb(OLD) - 'status' - 'void_journal_entry_id' - 'voided_at' - 'updated_at' THEN
    RAISE EXCEPTION 'Voiding manual journal % may not change any other field', OLD.id
      USING ERRCODE = '0A000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_manual_journals_immutable
  BEFORE UPDATE OR DELETE ON manual_journals
  FOR EACH ROW EXECUTE FUNCTION reject_posted_manual_journal_mutation();

-- Lines change only while the parent is DRAFT or TEMPLATE. NULL status means
-- the parent is already gone (the ON DELETE CASCADE of a draft).
CREATE OR REPLACE FUNCTION reject_non_draft_manual_journal_line_mutation() RETURNS trigger AS $$
DECLARE
  v_journal_id UUID;
  v_status     TEXT;
BEGIN
  v_journal_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.manual_journal_id ELSE NEW.manual_journal_id END;
  SELECT status INTO v_status FROM manual_journals WHERE id = v_journal_id;

  IF v_status IS NOT NULL AND v_status NOT IN ('DRAFT','TEMPLATE') THEN
    RAISE EXCEPTION 'Manual journal % is % — its lines cannot be changed', v_journal_id, v_status
      USING ERRCODE = '0A000';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_manual_journal_lines_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON manual_journal_lines
  FOR EACH ROW EXECUTE FUNCTION reject_non_draft_manual_journal_line_mutation();

CREATE OR REPLACE TRIGGER trg_manual_journals_updated_at
  BEFORE UPDATE ON manual_journals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_manual_journals_audit
  AFTER INSERT OR UPDATE OR DELETE ON manual_journals
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

CREATE OR REPLACE TRIGGER trg_manual_journal_lines_audit
  AFTER INSERT OR UPDATE OR DELETE ON manual_journal_lines
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

-- -------------------------------------------------------- recurring source
-- A repeating journal's source may now be a TEMPLATE manual journal. The old
-- chk_recurring_source_matches_kind (075) is replaced by a strictly wider one
-- (signed off in the approved plan). Replaying 075 cannot re-add it: its
-- CREATE TABLE IF NOT EXISTS is a no-op.

ALTER TABLE recurring_schedules ADD COLUMN IF NOT EXISTS source_manual_journal_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_recurring_source_manual_journal') THEN
    ALTER TABLE recurring_schedules
      ADD CONSTRAINT fk_recurring_source_manual_journal
      FOREIGN KEY (org_id, source_manual_journal_id)
      REFERENCES manual_journals (org_id, id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_recurring_schedules_source_manual_journal ON recurring_schedules (source_manual_journal_id);

ALTER TABLE recurring_schedules DROP CONSTRAINT IF EXISTS chk_recurring_source_matches_kind;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_recurring_source_matches_kind_v2') THEN
    ALTER TABLE recurring_schedules
      ADD CONSTRAINT chk_recurring_source_matches_kind_v2 CHECK (
           (kind = 'INVOICE' AND source_invoice_id IS NOT NULL AND source_bill_id IS NULL AND source_journal_entry_id IS NULL AND source_manual_journal_id IS NULL)
        OR (kind = 'BILL'    AND source_bill_id IS NOT NULL AND source_invoice_id IS NULL AND source_journal_entry_id IS NULL AND source_manual_journal_id IS NULL)
        OR (kind = 'JOURNAL' AND source_invoice_id IS NULL AND source_bill_id IS NULL
                             AND num_nonnulls(source_journal_entry_id, source_manual_journal_id) = 1));
  END IF;
END $$;

-- ---------------------------------------------------------------- backfill
-- Headers go in as DRAFT so their lines can be added (the line trigger
-- refuses lines on a POSTED parent), then are promoted to POSTED / VOIDED.

CREATE TEMP TABLE _mj_backfill ON COMMIT DROP AS
  SELECT gen_random_uuid() AS mj_id, e.id AS entry_id, e.org_id, e.entry_date, e.created_by, e.created_at,
         e.source_type, e.source_id, e.description, e.description_template,
         r.id AS reversal_id, r.created_at AS reversal_created_at
    FROM journal_entries e
    LEFT JOIN journal_entries r ON r.org_id = e.org_id AND r.reverses_entry_id = e.id
                               AND NOT EXISTS (SELECT 1 FROM recurring_runs rr WHERE rr.org_id = r.org_id AND rr.reversal_entry_id = r.id)
   WHERE e.source_type IN ('manual','recurring','migration_import')
     AND e.reverses_entry_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM manual_journals m WHERE m.journal_entry_id = e.id);

INSERT INTO manual_journals (id, org_id, status, origin, narration, narration_template, entry_date,
                             recurring_schedule_id, created_by, created_at)
  SELECT mj_id, org_id, 'DRAFT',
         CASE source_type WHEN 'manual' THEN 'MANUAL' WHEN 'recurring' THEN 'RECURRING' ELSE 'IMPORT' END,
         COALESCE(NULLIF(btrim(description), ''), 'Manual journal'), description_template, entry_date,
         CASE WHEN source_type = 'recurring' THEN source_id ELSE NULL END,
         created_by, created_at
    FROM _mj_backfill;

INSERT INTO manual_journal_lines (org_id, manual_journal_id, line_number, account_id, debit_cents, credit_cents, created_at)
  SELECT b.org_id, b.mj_id,
         row_number() OVER (PARTITION BY l.journal_entry_id ORDER BY l.created_at, l.id),
         l.account_id, l.debit_cents, l.credit_cents, l.created_at
    FROM _mj_backfill b JOIN ledger_lines l ON l.org_id = b.org_id AND l.journal_entry_id = b.entry_id;

UPDATE manual_journals m
   SET status = CASE WHEN b.reversal_id IS NULL THEN 'POSTED' ELSE 'VOIDED' END,
       journal_entry_id = b.entry_id, posted_at = b.created_at,
       void_journal_entry_id = b.reversal_id, voided_at = b.reversal_created_at
  FROM _mj_backfill b
 WHERE m.id = b.mj_id AND m.org_id = b.org_id;
