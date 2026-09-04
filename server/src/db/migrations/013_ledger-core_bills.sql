-- 013_ledger-core_bills.sql
-- Phase 3.9 — LedgerCore bills: the accounts-payable source document.
-- See docs/schema.md and docs/ledger-core.md#phase-39--accounts-payable.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.
--
-- This is the AP mirror of 009_ledger-core_invoices.sql, with one structural
-- difference: a bill has FOUR lifecycle states, not three, because approval
-- is a separate step from entry (a segregation-of-duties control — see
-- BILL_TRANSITIONS in types/ledger-core.ts). Lines stay editable through both
-- DRAFT and AWAITING_APPROVAL; only POSTED and VOID are locked.

-- ------------------------------------------------------------------- bills

CREATE TABLE IF NOT EXISTS bills (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT, matching invoices: an organization with posted bills cannot be
  -- deleted.
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  vendor_id             UUID NOT NULL,
  -- The VENDOR's own invoice number, required. Unique per vendor — this is
  -- the duplicate-payment control, not a display nicety: it is what stops
  -- the same vendor invoice being entered and paid twice.
  vendor_reference      TEXT NOT NULL CHECK (length(btrim(vendor_reference)) > 0 AND length(vendor_reference) <= 100),
  status                TEXT NOT NULL DEFAULT 'DRAFT'
                        CHECK (status IN ('DRAFT', 'AWAITING_APPROVAL', 'POSTED', 'VOID')),

  bill_date             DATE NOT NULL,
  due_date              DATE NOT NULL,
  -- Always the organization's base currency at write time (Phase 3.9's
  -- limit) — the FX engine that would let this legitimately vary is Phase 8.
  currency_code         CHAR(3) NOT NULL,

  -- Snapshotted at write time so a posted bill never silently changes when
  -- the vendor record is later edited.
  vendor_name_snapshot        TEXT NOT NULL,
  vendor_address_snapshot     TEXT,
  vendor_tax_number_snapshot  TEXT,

  notes                 TEXT,
  payment_terms         TEXT,

  subtotal_cents        BIGINT NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  tax_cents             BIGINT NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents           BIGINT NOT NULL DEFAULT 0 CHECK (total_cents >= 0),

  journal_entry_id      UUID,
  void_journal_entry_id UUID,
  submitted_at          TIMESTAMPTZ,
  posted_at             TIMESTAMPTZ,
  voided_at             TIMESTAMPTZ,
  approved_by           UUID REFERENCES users(id) ON DELETE RESTRICT,

  created_by            UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_bills_org_id_id UNIQUE (org_id, id),
  CONSTRAINT ux_bills_vendor_reference UNIQUE (org_id, vendor_id, vendor_reference),
  CONSTRAINT chk_bills_total CHECK (total_cents = subtotal_cents + tax_cents),
  CONSTRAINT chk_bills_due_not_before_bill_date CHECK (due_date >= bill_date),
  CONSTRAINT chk_bills_posted_complete CHECK (
    status <> 'POSTED' OR (journal_entry_id IS NOT NULL AND posted_at IS NOT NULL AND approved_by IS NOT NULL)
  ),

  CONSTRAINT fk_bills_vendor
    FOREIGN KEY (org_id, vendor_id) REFERENCES vendors (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_bills_journal_entry
    FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_bills_void_journal_entry
    FOREIGN KEY (org_id, void_journal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_bills_org_status_date ON bills (org_id, status, bill_date DESC);
CREATE INDEX IF NOT EXISTS idx_bills_org_status_due  ON bills (org_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_bills_vendor          ON bills (vendor_id);
CREATE INDEX IF NOT EXISTS idx_bills_journal_entry   ON bills (journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_bills_void_journal_entry ON bills (void_journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_bills_created_by      ON bills (created_by);
CREATE INDEX IF NOT EXISTS idx_bills_approved_by     ON bills (approved_by);

-- --------------------------------------------------------------- bill_lines

CREATE TABLE IF NOT EXISTS bill_lines (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  bill_id            UUID NOT NULL,

  line_number        SMALLINT NOT NULL CHECK (line_number > 0),
  description        TEXT NOT NULL CHECK (length(btrim(description)) > 0 AND length(description) <= 500),

  -- Thousandths of a unit — never a float. 2500 means 2.5.
  quantity_milli     BIGINT NOT NULL CHECK (quantity_milli > 0 AND quantity_milli <= 1000000000),
  unit_price_cents   BIGINT NOT NULL CHECK (unit_price_cents >= 0 AND unit_price_cents <= 1000000000000),
  expense_account_id UUID NOT NULL,
  -- Basis points — never a float. 1850 means 18.5%.
  tax_rate_bp        INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),

  net_cents          BIGINT NOT NULL CHECK (net_cents >= 0),
  tax_cents          BIGINT NOT NULL CHECK (tax_cents >= 0),

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_bill_lines_bill_line UNIQUE (bill_id, line_number),
  -- CASCADE on the parent FK deletes a draft's lines with it; the trigger
  -- below is what stops a non-editable bill (and therefore its lines) from
  -- ever being deleted in the first place.
  CONSTRAINT fk_bill_lines_bill
    FOREIGN KEY (org_id, bill_id) REFERENCES bills (org_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_bill_lines_expense_account
    FOREIGN KEY (org_id, expense_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_bill_lines_org_bill        ON bill_lines (org_id, bill_id);
CREATE INDEX IF NOT EXISTS idx_bill_lines_expense_account ON bill_lines (expense_account_id);

-- ------------------------------------------------------------------- triggers

-- Immutability once a bill leaves DRAFT/AWAITING_APPROVAL (guardrails rule
-- 6), enforced by the database and not only by the service. The single
-- carve-out is the POSTED -> VOID transition, which may touch only
-- status/voided_at/void_journal_entry_id — nothing else, including the money
-- columns, may move once posted.
CREATE OR REPLACE FUNCTION reject_posted_bill_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN ('DRAFT', 'AWAITING_APPROVAL') THEN
      RAISE EXCEPTION 'Bill % is % and cannot be deleted', OLD.id, OLD.status
        USING ERRCODE = '0A000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status IN ('DRAFT', 'AWAITING_APPROVAL') THEN
    RETURN NEW;
  END IF;

  IF NOT (OLD.status = 'POSTED' AND NEW.status = 'VOID') THEN
    RAISE EXCEPTION 'Bill % is % and is immutable', OLD.id, OLD.status
      USING ERRCODE = '0A000';
  END IF;

  IF to_jsonb(NEW) - 'status' - 'voided_at' - 'void_journal_entry_id' - 'updated_at'
     IS DISTINCT FROM
     to_jsonb(OLD) - 'status' - 'voided_at' - 'void_journal_entry_id' - 'updated_at' THEN
    RAISE EXCEPTION 'Voiding bill % may not change any other field', OLD.id
      USING ERRCODE = '0A000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_bills_immutable
  BEFORE UPDATE OR DELETE ON bills
  FOR EACH ROW EXECUTE FUNCTION reject_posted_bill_mutation();

-- A line may only be inserted, changed, or removed while its parent bill is
-- still DRAFT or AWAITING_APPROVAL. NULL status means the parent row is
-- already gone — the ON DELETE CASCADE of a draft bill, which the trigger
-- above already authorised — so that case passes through rather than raising.
CREATE OR REPLACE FUNCTION reject_locked_bill_line_mutation() RETURNS trigger AS $$
DECLARE
  v_bill_id UUID;
  v_status  TEXT;
BEGIN
  v_bill_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.bill_id ELSE NEW.bill_id END;
  SELECT status INTO v_status FROM bills WHERE id = v_bill_id;

  IF v_status IS NOT NULL AND v_status NOT IN ('DRAFT', 'AWAITING_APPROVAL') THEN
    RAISE EXCEPTION 'Bill % is % — its lines cannot be changed', v_bill_id, v_status
      USING ERRCODE = '0A000';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_bill_lines_editable_only
  BEFORE INSERT OR UPDATE OR DELETE ON bill_lines
  FOR EACH ROW EXECUTE FUNCTION reject_locked_bill_line_mutation();

-- Same-timing BEFORE UPDATE row triggers fire in name order:
-- trg_bills_immutable sorts before trg_bills_updated_at, so the guard above
-- sees NEW.updated_at exactly as the service wrote it. The to_jsonb
-- comparison excludes updated_at anyway, so either order is correct — do not
-- rename either trigger without rechecking this.
CREATE OR REPLACE TRIGGER trg_bills_updated_at
  BEFORE UPDATE ON bills
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
