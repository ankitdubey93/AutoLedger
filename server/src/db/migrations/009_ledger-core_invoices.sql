-- 009_ledger-core_invoices.sql
-- Phase 3.8 — LedgerCore sales invoices: draft, issue, void.
-- See docs/schema.md and docs/ledger-core.md#phase-38--sales-invoicing.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.

-- ------------------------------------------------------- composite-FK support

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ux_journal_entries_org_id_id') THEN
    ALTER TABLE journal_entries ADD CONSTRAINT ux_journal_entries_org_id_id UNIQUE (org_id, id);
  END IF;
END $$;

-- ------------------------------------------------------------------- invoices

CREATE TABLE IF NOT EXISTS invoices (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT, matching journal_entries: an organization with issued invoices
  -- cannot be deleted.
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  customer_id           UUID NOT NULL,
  -- NULL while DRAFT — allocated only at issue.
  invoice_number        TEXT,
  status                TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ISSUED', 'VOID')),

  issue_date            DATE NOT NULL,
  due_date              DATE NOT NULL,
  -- Always the organization's base currency at write time (Phase 3.8's
  -- limit) — the FX engine that would let this legitimately vary is Phase 8.
  currency_code         CHAR(3) NOT NULL,

  -- Snapshotted at issue-relevant write time so an issued invoice never
  -- silently changes when the customer record is later edited.
  customer_name_snapshot       TEXT NOT NULL,
  customer_address_snapshot    TEXT,
  customer_tax_number_snapshot TEXT,

  notes                 TEXT,
  payment_terms         TEXT,

  subtotal_cents        BIGINT NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  tax_cents             BIGINT NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents           BIGINT NOT NULL DEFAULT 0 CHECK (total_cents >= 0),

  journal_entry_id      UUID,
  void_journal_entry_id UUID,
  issued_at             TIMESTAMPTZ,
  voided_at             TIMESTAMPTZ,

  created_by            UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_invoices_org_id_id UNIQUE (org_id, id),
  -- Tolerates many NULLs — a UNIQUE constraint does not constrain NULLs, so
  -- every draft can sit numberless without colliding.
  CONSTRAINT ux_invoices_org_number UNIQUE (org_id, invoice_number),
  CONSTRAINT chk_invoices_total CHECK (total_cents = subtotal_cents + tax_cents),
  CONSTRAINT chk_invoices_due_not_before_issue CHECK (due_date >= issue_date),
  CONSTRAINT chk_invoices_issued_complete CHECK (
    status <> 'ISSUED' OR (invoice_number IS NOT NULL AND journal_entry_id IS NOT NULL AND issued_at IS NOT NULL)
  ),

  CONSTRAINT fk_invoices_customer
    FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_invoices_journal_entry
    FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_invoices_void_journal_entry
    FOREIGN KEY (org_id, void_journal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_invoices_org_status_date ON invoices (org_id, status, issue_date DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices (customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_journal_entry ON invoices (journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_invoices_void_journal_entry ON invoices (void_journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_invoices_created_by ON invoices (created_by);

-- -------------------------------------------------------------- invoice_lines

CREATE TABLE IF NOT EXISTS invoice_lines (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  invoice_id         UUID NOT NULL,

  line_number        SMALLINT NOT NULL CHECK (line_number > 0),
  description        TEXT NOT NULL CHECK (length(btrim(description)) > 0 AND length(description) <= 500),

  -- Thousandths of a unit — never a float. 2500 means 2.5.
  quantity_milli     BIGINT NOT NULL CHECK (quantity_milli > 0 AND quantity_milli <= 1000000000),
  unit_price_cents   BIGINT NOT NULL CHECK (unit_price_cents >= 0 AND unit_price_cents <= 1000000000000),
  revenue_account_id UUID NOT NULL,
  -- Basis points — never a float. 1850 means 18.5%.
  tax_rate_bp        INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),

  net_cents          BIGINT NOT NULL CHECK (net_cents >= 0),
  tax_cents          BIGINT NOT NULL CHECK (tax_cents >= 0),

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_invoice_lines_invoice_line UNIQUE (invoice_id, line_number),
  -- CASCADE on the parent FK deletes a draft's lines with it; the trigger
  -- below is what stops a non-draft invoice (and therefore its lines) from
  -- ever being deleted in the first place.
  CONSTRAINT fk_invoice_lines_invoice
    FOREIGN KEY (org_id, invoice_id) REFERENCES invoices (org_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_invoice_lines_revenue_account
    FOREIGN KEY (org_id, revenue_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines (invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_revenue_account ON invoice_lines (revenue_account_id);

-- ------------------------------------------------------------------- triggers

-- Immutability once an invoice leaves DRAFT (guardrails rule 6), enforced by
-- the database and not only by the service. The single carve-out is the
-- ISSUED -> VOID transition, which may touch only status/voided_at/
-- void_journal_entry_id — nothing else, including the money columns, may
-- move once issued.
CREATE OR REPLACE FUNCTION reject_issued_invoice_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Invoice % is % and cannot be deleted', OLD.id, OLD.status
        USING ERRCODE = '0A000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'DRAFT' THEN
    RETURN NEW;
  END IF;

  IF NOT (OLD.status = 'ISSUED' AND NEW.status = 'VOID') THEN
    RAISE EXCEPTION 'Invoice % is % and is immutable', OLD.id, OLD.status
      USING ERRCODE = '0A000';
  END IF;

  IF to_jsonb(NEW) - 'status' - 'voided_at' - 'void_journal_entry_id' - 'updated_at'
     IS DISTINCT FROM
     to_jsonb(OLD) - 'status' - 'voided_at' - 'void_journal_entry_id' - 'updated_at' THEN
    RAISE EXCEPTION 'Voiding invoice % may not change any other field', OLD.id
      USING ERRCODE = '0A000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_invoices_immutable
  BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION reject_issued_invoice_mutation();

-- A line may only be inserted, changed, or removed while its parent invoice
-- is still DRAFT. NULL status means the parent row is already gone — the
-- ON DELETE CASCADE of a DRAFT invoice, which the trigger above already
-- authorised — so that case passes through rather than raising.
CREATE OR REPLACE FUNCTION reject_non_draft_invoice_line_mutation() RETURNS trigger AS $$
DECLARE
  v_invoice_id UUID;
  v_status     TEXT;
BEGIN
  v_invoice_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  SELECT status INTO v_status FROM invoices WHERE id = v_invoice_id;

  IF v_status IS NOT NULL AND v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Invoice % is % — its lines cannot be changed', v_invoice_id, v_status
      USING ERRCODE = '0A000';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_invoice_lines_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION reject_non_draft_invoice_line_mutation();

-- Same-timing BEFORE UPDATE row triggers fire in name order:
-- trg_invoices_immutable sorts before trg_invoices_updated_at, so the guard
-- above sees NEW.updated_at exactly as the service wrote it. The to_jsonb
-- comparison excludes updated_at anyway, so either order is correct — do not
-- rename either trigger without rechecking this.
CREATE OR REPLACE TRIGGER trg_invoices_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
