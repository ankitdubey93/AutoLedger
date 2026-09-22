-- 063_ledger-core_credit_debit_notes.sql
-- Phase 26 — LedgerCore credit notes (AR) and debit notes (AP).
-- See docs/schema.md and docs/ledger-core.md#phase-26--credit--debit-notes.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.
--
-- A credit note is issued by us to a customer and reduces what they owe on an
-- ISSUED invoice; a debit note is issued by us to a vendor and reduces what we
-- owe on a POSTED bill. Each references its original document, inherits its
-- party, currency and frozen fx_rate, and may never — cumulatively with every
-- other ISSUED note against the same original — exceed that original's total.
--
-- A note is applied to documents through an insert-only allocation table, the
-- same shape as payment_allocations. Settlement ("amount due") is still never
-- stored: it is total − POSTED payment allocations − ISSUED note allocations,
-- derived on every read (services/ledger-core/settlementSql.ts). Voiding a note
-- un-applies it for free because its allocations stop counting once the note
-- leaves ISSUED — exactly the trick 014 uses for voided payments.

-- --------------------------------------------------------- numbering counters

-- Gapless, per-org, allocated at issue inside the issuing transaction — the
-- same counter-row pattern as the invoice number (007). Separate series per
-- document type: a note never consumes an invoice number.
ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS credit_note_prefix      TEXT    NOT NULL DEFAULT 'CN-' CHECK (length(credit_note_prefix) <= 12);
ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS credit_note_next_number INTEGER NOT NULL DEFAULT 1     CHECK (credit_note_next_number > 0);
ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS debit_note_prefix       TEXT    NOT NULL DEFAULT 'DN-' CHECK (length(debit_note_prefix) <= 12);
ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS debit_note_next_number  INTEGER NOT NULL DEFAULT 1     CHECK (debit_note_next_number > 0);

-- ------------------------------------------------------------- credit_notes

CREATE TABLE IF NOT EXISTS credit_notes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  customer_id           UUID NOT NULL,
  invoice_id            UUID NOT NULL,
  -- NULL while DRAFT — allocated only at issue.
  credit_note_number    TEXT,
  status                TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ISSUED', 'VOID')),
  reason_code           TEXT NOT NULL
                        CHECK (reason_code IN ('RETURN', 'PRICE_ADJUSTMENT', 'DISCOUNT', 'DAMAGED', 'OTHER')),
  reason                TEXT CHECK (reason IS NULL OR length(reason) <= 500),

  issue_date            DATE NOT NULL,
  -- Both copied from the original invoice, never client-supplied: a note
  -- posted at the original's own rate un-does exactly what the original did,
  -- so applying it back to that invoice can never create an FX difference.
  currency_code         CHAR(3) NOT NULL,
  fx_rate               NUMERIC(18,8) NOT NULL DEFAULT 1 CHECK (fx_rate > 0 AND fx_rate <= 1000000),

  -- The invoice's own snapshot, so the note matches the document it corrects.
  customer_name_snapshot       TEXT NOT NULL,
  customer_address_snapshot    TEXT,
  customer_tax_number_snapshot TEXT,
  notes                 TEXT,

  subtotal_cents        BIGINT NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  tax_cents             BIGINT NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents           BIGINT NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  base_subtotal_cents   BIGINT NOT NULL DEFAULT 0,
  base_tax_cents        BIGINT NOT NULL DEFAULT 0,
  base_total_cents      BIGINT NOT NULL DEFAULT 0,

  journal_entry_id      UUID,
  void_journal_entry_id UUID,
  issued_at             TIMESTAMPTZ,
  voided_at             TIMESTAMPTZ,

  created_by            UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_credit_notes_org_id_id  UNIQUE (org_id, id),
  CONSTRAINT ux_credit_notes_org_number UNIQUE (org_id, credit_note_number),
  CONSTRAINT chk_credit_notes_total CHECK (total_cents = subtotal_cents + tax_cents),
  CONSTRAINT chk_credit_notes_issued_complete CHECK (
    status <> 'ISSUED' OR (credit_note_number IS NOT NULL AND journal_entry_id IS NOT NULL
                           AND issued_at IS NOT NULL AND total_cents > 0)
  ),
  CONSTRAINT fk_credit_notes_customer
    FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_credit_notes_invoice
    FOREIGN KEY (org_id, invoice_id) REFERENCES invoices (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_credit_notes_journal_entry
    FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_credit_notes_void_journal_entry
    FOREIGN KEY (org_id, void_journal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_credit_notes_org_status_date    ON credit_notes (org_id, status, issue_date DESC);
CREATE INDEX IF NOT EXISTS idx_credit_notes_customer           ON credit_notes (customer_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_invoice            ON credit_notes (invoice_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_journal_entry      ON credit_notes (journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_void_journal_entry ON credit_notes (void_journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_created_by         ON credit_notes (created_by);

CREATE TABLE IF NOT EXISTS credit_note_lines (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  credit_note_id     UUID NOT NULL,

  line_number        SMALLINT NOT NULL CHECK (line_number > 0),
  description        TEXT NOT NULL CHECK (length(btrim(description)) > 0 AND length(description) <= 500),
  quantity_milli     BIGINT NOT NULL CHECK (quantity_milli > 0 AND quantity_milli <= 1000000000),
  unit_price_cents   BIGINT NOT NULL CHECK (unit_price_cents >= 0 AND unit_price_cents <= 1000000000000),
  revenue_account_id UUID NOT NULL,
  tax_rate_bp        INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  net_cents          BIGINT NOT NULL CHECK (net_cents >= 0),
  tax_cents          BIGINT NOT NULL CHECK (tax_cents >= 0),

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_credit_note_lines_note_line UNIQUE (credit_note_id, line_number),
  CONSTRAINT fk_credit_note_lines_note
    FOREIGN KEY (org_id, credit_note_id) REFERENCES credit_notes (org_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_credit_note_lines_account
    FOREIGN KEY (org_id, revenue_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_credit_note_lines_org_note ON credit_note_lines (org_id, credit_note_id);
CREATE INDEX IF NOT EXISTS idx_credit_note_lines_account  ON credit_note_lines (revenue_account_id);

CREATE TABLE IF NOT EXISTS credit_note_allocations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  credit_note_id    UUID NOT NULL,
  invoice_id        UUID NOT NULL,
  amount_cents      BIGINT NOT NULL CHECK (amount_cents > 0),
  base_amount_cents BIGINT NOT NULL CHECK (base_amount_cents >= 0),
  allocation_date   DATE NOT NULL,
  created_by        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fk_credit_note_allocations_note
    FOREIGN KEY (org_id, credit_note_id) REFERENCES credit_notes (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_credit_note_allocations_invoice
    FOREIGN KEY (org_id, invoice_id) REFERENCES invoices (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_credit_note_allocations_org_note ON credit_note_allocations (org_id, credit_note_id);
CREATE INDEX IF NOT EXISTS idx_credit_note_allocations_invoice  ON credit_note_allocations (invoice_id);
CREATE INDEX IF NOT EXISTS idx_credit_note_allocations_created_by ON credit_note_allocations (created_by);

-- -------------------------------------------------------------- debit_notes

CREATE TABLE IF NOT EXISTS debit_notes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  vendor_id             UUID NOT NULL,
  bill_id               UUID NOT NULL,
  debit_note_number     TEXT,
  status                TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ISSUED', 'VOID')),
  reason_code           TEXT NOT NULL
                        CHECK (reason_code IN ('RETURN', 'PRICE_ADJUSTMENT', 'DISCOUNT', 'DAMAGED', 'OTHER')),
  reason                TEXT CHECK (reason IS NULL OR length(reason) <= 500),
  -- The vendor's own credit-note number, when they send one back.
  vendor_credit_reference TEXT CHECK (vendor_credit_reference IS NULL OR length(vendor_credit_reference) <= 100),

  issue_date            DATE NOT NULL,
  currency_code         CHAR(3) NOT NULL,
  fx_rate               NUMERIC(18,8) NOT NULL DEFAULT 1 CHECK (fx_rate > 0 AND fx_rate <= 1000000),

  vendor_name_snapshot       TEXT NOT NULL,
  vendor_address_snapshot    TEXT,
  vendor_tax_number_snapshot TEXT,
  notes                 TEXT,

  subtotal_cents        BIGINT NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  tax_cents             BIGINT NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents           BIGINT NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  base_subtotal_cents   BIGINT NOT NULL DEFAULT 0,
  base_tax_cents        BIGINT NOT NULL DEFAULT 0,
  base_total_cents      BIGINT NOT NULL DEFAULT 0,

  journal_entry_id      UUID,
  void_journal_entry_id UUID,
  issued_at             TIMESTAMPTZ,
  voided_at             TIMESTAMPTZ,

  created_by            UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_debit_notes_org_id_id  UNIQUE (org_id, id),
  CONSTRAINT ux_debit_notes_org_number UNIQUE (org_id, debit_note_number),
  CONSTRAINT chk_debit_notes_total CHECK (total_cents = subtotal_cents + tax_cents),
  CONSTRAINT chk_debit_notes_issued_complete CHECK (
    status <> 'ISSUED' OR (debit_note_number IS NOT NULL AND journal_entry_id IS NOT NULL
                           AND issued_at IS NOT NULL AND total_cents > 0)
  ),
  CONSTRAINT fk_debit_notes_vendor
    FOREIGN KEY (org_id, vendor_id) REFERENCES vendors (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_debit_notes_bill
    FOREIGN KEY (org_id, bill_id) REFERENCES bills (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_debit_notes_journal_entry
    FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_debit_notes_void_journal_entry
    FOREIGN KEY (org_id, void_journal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_debit_notes_org_status_date    ON debit_notes (org_id, status, issue_date DESC);
CREATE INDEX IF NOT EXISTS idx_debit_notes_vendor             ON debit_notes (vendor_id);
CREATE INDEX IF NOT EXISTS idx_debit_notes_bill               ON debit_notes (bill_id);
CREATE INDEX IF NOT EXISTS idx_debit_notes_journal_entry      ON debit_notes (journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_debit_notes_void_journal_entry ON debit_notes (void_journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_debit_notes_created_by         ON debit_notes (created_by);

CREATE TABLE IF NOT EXISTS debit_note_lines (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  debit_note_id      UUID NOT NULL,

  line_number        SMALLINT NOT NULL CHECK (line_number > 0),
  description        TEXT NOT NULL CHECK (length(btrim(description)) > 0 AND length(description) <= 500),
  quantity_milli     BIGINT NOT NULL CHECK (quantity_milli > 0 AND quantity_milli <= 1000000000),
  unit_price_cents   BIGINT NOT NULL CHECK (unit_price_cents >= 0 AND unit_price_cents <= 1000000000000),
  expense_account_id UUID NOT NULL,
  tax_rate_bp        INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  net_cents          BIGINT NOT NULL CHECK (net_cents >= 0),
  tax_cents          BIGINT NOT NULL CHECK (tax_cents >= 0),

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_debit_note_lines_note_line UNIQUE (debit_note_id, line_number),
  CONSTRAINT fk_debit_note_lines_note
    FOREIGN KEY (org_id, debit_note_id) REFERENCES debit_notes (org_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_debit_note_lines_account
    FOREIGN KEY (org_id, expense_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_debit_note_lines_org_note ON debit_note_lines (org_id, debit_note_id);
CREATE INDEX IF NOT EXISTS idx_debit_note_lines_account  ON debit_note_lines (expense_account_id);

CREATE TABLE IF NOT EXISTS debit_note_allocations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  debit_note_id     UUID NOT NULL,
  bill_id           UUID NOT NULL,
  amount_cents      BIGINT NOT NULL CHECK (amount_cents > 0),
  base_amount_cents BIGINT NOT NULL CHECK (base_amount_cents >= 0),
  allocation_date   DATE NOT NULL,
  created_by        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fk_debit_note_allocations_note
    FOREIGN KEY (org_id, debit_note_id) REFERENCES debit_notes (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_debit_note_allocations_bill
    FOREIGN KEY (org_id, bill_id) REFERENCES bills (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_debit_note_allocations_org_note   ON debit_note_allocations (org_id, debit_note_id);
CREATE INDEX IF NOT EXISTS idx_debit_note_allocations_bill       ON debit_note_allocations (bill_id);
CREATE INDEX IF NOT EXISTS idx_debit_note_allocations_created_by ON debit_note_allocations (created_by);

-- -------------------------------------------------------------- immutability

-- Same rule as invoices (009): a DRAFT is an ordinary editable row; once
-- issued only the ISSUED -> VOID transition is allowed, and it may touch only
-- status/voided_at/void_journal_entry_id (guardrails rule 6). One function
-- serves both note tables — nothing in it names a table.
CREATE OR REPLACE FUNCTION reject_issued_note_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Note % is % and cannot be deleted', OLD.id, OLD.status
        USING ERRCODE = '0A000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'DRAFT' THEN
    RETURN NEW;
  END IF;

  IF NOT (OLD.status = 'ISSUED' AND NEW.status = 'VOID') THEN
    RAISE EXCEPTION 'Note % is % and is immutable', OLD.id, OLD.status
      USING ERRCODE = '0A000';
  END IF;

  IF to_jsonb(NEW) - 'status' - 'voided_at' - 'void_journal_entry_id' - 'updated_at'
     IS DISTINCT FROM
     to_jsonb(OLD) - 'status' - 'voided_at' - 'void_journal_entry_id' - 'updated_at' THEN
    RAISE EXCEPTION 'Voiding note % may not change any other field', OLD.id
      USING ERRCODE = '0A000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_credit_notes_immutable
  BEFORE UPDATE OR DELETE ON credit_notes
  FOR EACH ROW EXECUTE FUNCTION reject_issued_note_mutation();

CREATE OR REPLACE TRIGGER trg_debit_notes_immutable
  BEFORE UPDATE OR DELETE ON debit_notes
  FOR EACH ROW EXECUTE FUNCTION reject_issued_note_mutation();

-- A line may only change while its parent note is DRAFT. NULL status means
-- the parent is already gone (the ON DELETE CASCADE of a draft), which the
-- trigger above already authorised.
CREATE OR REPLACE FUNCTION reject_non_draft_note_line_mutation() RETURNS trigger AS $$
DECLARE
  v_note_id UUID;
  v_status  TEXT;
BEGIN
  IF TG_TABLE_NAME = 'credit_note_lines' THEN
    v_note_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.credit_note_id ELSE NEW.credit_note_id END;
    SELECT status INTO v_status FROM credit_notes WHERE id = v_note_id;
  ELSE
    v_note_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.debit_note_id ELSE NEW.debit_note_id END;
    SELECT status INTO v_status FROM debit_notes WHERE id = v_note_id;
  END IF;

  IF v_status IS NOT NULL AND v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Note % is % — its lines cannot be changed', v_note_id, v_status
      USING ERRCODE = '0A000';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_credit_note_lines_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON credit_note_lines
  FOR EACH ROW EXECUTE FUNCTION reject_non_draft_note_line_mutation();

CREATE OR REPLACE TRIGGER trg_debit_note_lines_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON debit_note_lines
  FOR EACH ROW EXECUTE FUNCTION reject_non_draft_note_line_mutation();

-- Allocations are insert-only, always — voiding a note leaves them in place;
-- they stop counting because every settlement query filters status = 'ISSUED'.
CREATE OR REPLACE FUNCTION reject_note_allocation_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Note allocations are immutable and insert-only'
    USING ERRCODE = '0A000';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_credit_note_allocations_immutable
  BEFORE UPDATE OR DELETE ON credit_note_allocations
  FOR EACH ROW EXECUTE FUNCTION reject_note_allocation_mutation();

CREATE OR REPLACE TRIGGER trg_debit_note_allocations_immutable
  BEFORE UPDATE OR DELETE ON debit_note_allocations
  FOR EACH ROW EXECUTE FUNCTION reject_note_allocation_mutation();

-- ------------------------------------------------------- settlement invariants

-- Two cross-row invariants per allocation, checked at COMMIT (deferred for the
-- same reason as 014's: the note, its JE and its allocation are written in one
-- transaction, in an order a non-deferred check would see half-finished):
--   (a) a note never applies more than its own total;
--   (b) POSTED payments + ISSUED notes never settle more than the document's total.
CREATE OR REPLACE FUNCTION assert_note_allocation_within_limits() RETURNS trigger AS $$
DECLARE
  note_total     BIGINT;
  note_applied   BIGINT;
  document_total BIGINT;
  settled        BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'credit_note_allocations' THEN
    SELECT total_cents INTO note_total FROM credit_notes WHERE id = NEW.credit_note_id;
    SELECT COALESCE(SUM(amount_cents), 0) INTO note_applied
      FROM credit_note_allocations WHERE credit_note_id = NEW.credit_note_id;
    IF note_applied > note_total THEN
      RAISE EXCEPTION 'Credit note % applies % but its total is %', NEW.credit_note_id, note_applied, note_total
        USING ERRCODE = 'P0001';
    END IF;

    SELECT total_cents INTO document_total FROM invoices WHERE id = NEW.invoice_id;
    settled :=
        (SELECT COALESCE(SUM(pa.amount_cents), 0)
           FROM payment_allocations pa
           JOIN payments p ON p.id = pa.payment_id AND p.org_id = pa.org_id
          WHERE pa.invoice_id = NEW.invoice_id AND p.status = 'POSTED')
      + (SELECT COALESCE(SUM(a.amount_cents), 0)
           FROM credit_note_allocations a
           JOIN credit_notes n ON n.id = a.credit_note_id AND n.org_id = a.org_id
          WHERE a.invoice_id = NEW.invoice_id AND n.status = 'ISSUED');
  ELSE
    SELECT total_cents INTO note_total FROM debit_notes WHERE id = NEW.debit_note_id;
    SELECT COALESCE(SUM(amount_cents), 0) INTO note_applied
      FROM debit_note_allocations WHERE debit_note_id = NEW.debit_note_id;
    IF note_applied > note_total THEN
      RAISE EXCEPTION 'Debit note % applies % but its total is %', NEW.debit_note_id, note_applied, note_total
        USING ERRCODE = 'P0001';
    END IF;

    SELECT total_cents INTO document_total FROM bills WHERE id = NEW.bill_id;
    settled :=
        (SELECT COALESCE(SUM(pa.amount_cents), 0)
           FROM payment_allocations pa
           JOIN payments p ON p.id = pa.payment_id AND p.org_id = pa.org_id
          WHERE pa.bill_id = NEW.bill_id AND p.status = 'POSTED')
      + (SELECT COALESCE(SUM(a.amount_cents), 0)
           FROM debit_note_allocations a
           JOIN debit_notes n ON n.id = a.debit_note_id AND n.org_id = a.org_id
          WHERE a.bill_id = NEW.bill_id AND n.status = 'ISSUED');
  END IF;

  IF settled > document_total THEN
    RAISE EXCEPTION 'Settlement of % exceeds document total of %', settled, document_total
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_credit_note_allocations_limits ON credit_note_allocations;
CREATE CONSTRAINT TRIGGER trg_credit_note_allocations_limits
  AFTER INSERT ON credit_note_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_note_allocation_within_limits();

DROP TRIGGER IF EXISTS trg_debit_note_allocations_limits ON debit_note_allocations;
CREATE CONSTRAINT TRIGGER trg_debit_note_allocations_limits
  AFTER INSERT ON debit_note_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_note_allocation_within_limits();

-- Every ISSUED note against one original, summed, may never exceed that
-- original's total. The service checks this too, under a FOR UPDATE lock on
-- the original; this is the backstop against any other write path.
CREATE OR REPLACE FUNCTION assert_notes_within_original() RETURNS trigger AS $$
DECLARE
  document_total BIGINT;
  notes_total    BIGINT;
  document_id    UUID;
BEGIN
  IF NEW.status <> 'ISSUED' THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'credit_notes' THEN
    document_id := NEW.invoice_id;
    SELECT total_cents INTO document_total FROM invoices WHERE id = NEW.invoice_id;
    SELECT COALESCE(SUM(total_cents), 0) INTO notes_total
      FROM credit_notes WHERE invoice_id = NEW.invoice_id AND status = 'ISSUED';
  ELSE
    document_id := NEW.bill_id;
    SELECT total_cents INTO document_total FROM bills WHERE id = NEW.bill_id;
    SELECT COALESCE(SUM(total_cents), 0) INTO notes_total
      FROM debit_notes WHERE bill_id = NEW.bill_id AND status = 'ISSUED';
  END IF;

  IF notes_total > document_total THEN
    RAISE EXCEPTION 'Notes against document % total % but the document total is %',
      document_id, notes_total, document_total
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_credit_notes_within_invoice ON credit_notes;
CREATE CONSTRAINT TRIGGER trg_credit_notes_within_invoice
  AFTER INSERT OR UPDATE ON credit_notes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_notes_within_original();

DROP TRIGGER IF EXISTS trg_debit_notes_within_bill ON debit_notes;
CREATE CONSTRAINT TRIGGER trg_debit_notes_within_bill
  AFTER INSERT OR UPDATE ON debit_notes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_notes_within_original();

-- Replaces 014's function body (014 itself is never edited — rule 13; the
-- trigger trg_allocations_no_overallocation stays attached and simply runs the
-- new body). A payment's allocation must now fit inside what is left after
-- ISSUED notes too, not just after other POSTED payments.
CREATE OR REPLACE FUNCTION assert_no_overallocation() RETURNS trigger AS $$
DECLARE
  document_total   BIGINT;
  total_allocated  BIGINT;
BEGIN
  IF NEW.invoice_id IS NOT NULL THEN
    SELECT total_cents INTO document_total FROM invoices WHERE id = NEW.invoice_id;
  ELSE
    SELECT total_cents INTO document_total FROM bills WHERE id = NEW.bill_id;
  END IF;

  SELECT COALESCE(SUM(pa.amount_cents), 0)
    INTO total_allocated
    FROM payment_allocations pa
    JOIN payments p ON p.id = pa.payment_id AND p.org_id = pa.org_id
   WHERE p.status = 'POSTED'
     AND ((NEW.invoice_id IS NOT NULL AND pa.invoice_id = NEW.invoice_id) OR
          (NEW.bill_id    IS NOT NULL AND pa.bill_id    = NEW.bill_id));

  total_allocated := total_allocated
    + (SELECT COALESCE(SUM(a.amount_cents), 0)
         FROM credit_note_allocations a
         JOIN credit_notes n ON n.id = a.credit_note_id AND n.org_id = a.org_id
        WHERE NEW.invoice_id IS NOT NULL AND a.invoice_id = NEW.invoice_id AND n.status = 'ISSUED')
    + (SELECT COALESCE(SUM(a.amount_cents), 0)
         FROM debit_note_allocations a
         JOIN debit_notes n ON n.id = a.debit_note_id AND n.org_id = a.org_id
        WHERE NEW.bill_id IS NOT NULL AND a.bill_id = NEW.bill_id AND n.status = 'ISSUED');

  IF total_allocated > document_total THEN
    RAISE EXCEPTION 'Allocations of % exceed document total of %', total_allocated, document_total
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------ updated_at and audit

-- Name order matters for same-timing BEFORE UPDATE triggers: *_immutable sorts
-- before *_updated_at, matching 009's reasoning.
CREATE OR REPLACE TRIGGER trg_credit_notes_updated_at
  BEFORE UPDATE ON credit_notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_debit_notes_updated_at
  BEFORE UPDATE ON debit_notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Phase 5's audit trail on the parents only, like fx_revaluations (026): a
-- note's lines are frozen at issue and its allocations are insert-only.
CREATE OR REPLACE TRIGGER trg_credit_notes_audit
  AFTER INSERT OR UPDATE OR DELETE ON credit_notes
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

CREATE OR REPLACE TRIGGER trg_debit_notes_audit
  AFTER INSERT OR UPDATE OR DELETE ON debit_notes
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');
