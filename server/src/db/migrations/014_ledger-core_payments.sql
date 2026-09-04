-- 014_ledger-core_payments.sql
-- Phase 3.9 — LedgerCore payments: settlement of invoices and bills.
-- See docs/schema.md and docs/ledger-core.md#phase-39--accounts-payable.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.
--
-- One table pair for both directions (RECEIVE against an invoice, PAY against
-- a bill) — identical columns, identical validation, identical GL shape with
-- the signs flipped. A payment is born POSTED: there is no draft, and
-- correction is POST /:id/void, which posts a reversal, mirroring
-- journal_entries itself.
--
-- Settlement state (how much of a document is paid) is NEVER stored here or
-- anywhere else — it is derived on every read by summing POSTED allocations,
-- the same no-summary-table discipline dashboardService and reportService
-- already follow. Voiding a payment un-settles its documents for free because
-- allocation rows are immutable and simply stop counting once their payment's
-- status leaves POSTED.

-- ------------------------------------------------------------------ payments

CREATE TABLE IF NOT EXISTS payments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  direction             TEXT NOT NULL CHECK (direction IN ('RECEIVE', 'PAY')),
  status                TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'VOID')),

  payment_date          DATE NOT NULL,
  currency_code         CHAR(3) NOT NULL,
  amount_cents          BIGINT NOT NULL CHECK (amount_cents > 0),

  cash_account_id       UUID NOT NULL,
  customer_id           UUID,
  vendor_id             UUID,

  method                TEXT CHECK (method IS NULL OR length(method) <= 40),
  reference             TEXT CHECK (reference IS NULL OR length(reference) <= 100),
  notes                 TEXT,

  journal_entry_id      UUID NOT NULL,
  void_journal_entry_id UUID,
  voided_at             TIMESTAMPTZ,

  created_by            UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_payments_org_id_id UNIQUE (org_id, id),
  -- A RECEIVE names a customer and no vendor; a PAY names a vendor and no
  -- customer. Neither direction can name both, and neither can name nothing.
  CONSTRAINT chk_payments_counterparty CHECK (
    (direction = 'RECEIVE' AND customer_id IS NOT NULL AND vendor_id IS NULL) OR
    (direction = 'PAY'     AND vendor_id   IS NOT NULL AND customer_id IS NULL)
  ),
  CONSTRAINT fk_payments_cash_account
    FOREIGN KEY (org_id, cash_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_payments_customer
    FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_payments_vendor
    FOREIGN KEY (org_id, vendor_id) REFERENCES vendors (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_payments_journal_entry
    FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_payments_void_journal_entry
    FOREIGN KEY (org_id, void_journal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_payments_org_status_date ON payments (org_id, status, payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_payments_cash_account    ON payments (cash_account_id);
CREATE INDEX IF NOT EXISTS idx_payments_customer        ON payments (customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_vendor          ON payments (vendor_id);
CREATE INDEX IF NOT EXISTS idx_payments_journal_entry   ON payments (journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_payments_void_journal_entry ON payments (void_journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_payments_created_by      ON payments (created_by);

-- ---------------------------------------------------------- payment_allocations

CREATE TABLE IF NOT EXISTS payment_allocations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  payment_id   UUID NOT NULL,
  invoice_id   UUID,
  bill_id      UUID,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_allocation_one_target CHECK (
    (invoice_id IS NOT NULL AND bill_id IS NULL) OR
    (invoice_id IS NULL AND bill_id IS NOT NULL)
  ),
  -- One row per (payment, document): a payment allocates to a given invoice
  -- once, with one amount. NULLs are not constrained by UNIQUE, so the unused
  -- column never collides.
  CONSTRAINT ux_allocation_payment_invoice UNIQUE (payment_id, invoice_id),
  CONSTRAINT ux_allocation_payment_bill    UNIQUE (payment_id, bill_id),
  CONSTRAINT fk_allocation_payment
    FOREIGN KEY (org_id, payment_id) REFERENCES payments (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_allocation_invoice
    FOREIGN KEY (org_id, invoice_id) REFERENCES invoices (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_allocation_bill
    FOREIGN KEY (org_id, bill_id) REFERENCES bills (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_allocations_org_payment ON payment_allocations (org_id, payment_id);
CREATE INDEX IF NOT EXISTS idx_allocations_invoice     ON payment_allocations (invoice_id);
CREATE INDEX IF NOT EXISTS idx_allocations_bill        ON payment_allocations (bill_id);

-- ------------------------------------------------- allocation invariants

-- A payment's allocations must exist and must sum to its amount. This cannot
-- be a CHECK: it is a property of every allocation row belonging to a
-- payment, evaluated across rows. DEFERRABLE INITIALLY DEFERRED is required
-- — the payment row is always inserted before its allocations exist within
-- the same transaction, so a non-deferred check would fire mid-transaction
-- and always fail, exactly the reasoning behind
-- trg_ledger_lines_balanced (004).
CREATE OR REPLACE FUNCTION assert_payment_allocations_complete() RETURNS trigger AS $$
DECLARE
  total_allocated BIGINT;
  allocation_count INTEGER;
BEGIN
  -- A voided payment's allocations are frozen in place (they simply stop
  -- counting toward settlement elsewhere) — nothing to assert here.
  IF NEW.status = 'VOID' THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(amount_cents), 0), COUNT(*)
    INTO total_allocated, allocation_count
    FROM payment_allocations
   WHERE payment_id = NEW.id;

  IF allocation_count = 0 THEN
    RAISE EXCEPTION 'Payment % has no allocations', NEW.id
      USING ERRCODE = 'P0001';
  END IF;

  IF total_allocated <> NEW.amount_cents THEN
    RAISE EXCEPTION 'Payment % allocates % but its amount is %',
      NEW.id, total_allocated, NEW.amount_cents
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payments_allocations_complete ON payments;
CREATE CONSTRAINT TRIGGER trg_payments_allocations_complete
  AFTER INSERT OR UPDATE ON payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_payment_allocations_complete();

-- Allocations against one document must never exceed its total — a
-- cross-row, cross-table invariant, so again a deferred constraint trigger
-- rather than a CHECK. Only POSTED payments' allocations count, which is
-- what makes voiding a payment un-settle its documents without touching this
-- table.
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

  IF total_allocated > document_total THEN
    RAISE EXCEPTION 'Allocations of % exceed document total of %', total_allocated, document_total
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_allocations_no_overallocation ON payment_allocations;
CREATE CONSTRAINT TRIGGER trg_allocations_no_overallocation
  AFTER INSERT ON payment_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_no_overallocation();

-- ----------------------------------------------------------- immutability

-- A payment is born POSTED; the only permitted transition is POSTED -> VOID,
-- touching only status/voided_at/void_journal_entry_id — nothing else,
-- including amount_cents, may move once posted (guardrails rule 6).
CREATE OR REPLACE FUNCTION reject_payment_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payment % is immutable and cannot be deleted', OLD.id
      USING ERRCODE = '0A000';
  END IF;

  IF NOT (OLD.status = 'POSTED' AND NEW.status = 'VOID') THEN
    RAISE EXCEPTION 'Payment % is immutable', OLD.id
      USING ERRCODE = '0A000';
  END IF;

  IF to_jsonb(NEW) - 'status' - 'voided_at' - 'void_journal_entry_id' - 'updated_at'
     IS DISTINCT FROM
     to_jsonb(OLD) - 'status' - 'voided_at' - 'void_journal_entry_id' - 'updated_at' THEN
    RAISE EXCEPTION 'Voiding payment % may not change any other field', OLD.id
      USING ERRCODE = '0A000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_payments_immutable
  BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION reject_payment_mutation();

-- Allocations are insert-only, always. Voiding a payment leaves them in
-- place — they stop counting toward settlement because every settlement
-- query filters p.status = 'POSTED' — rather than being edited or removed.
CREATE OR REPLACE FUNCTION reject_allocation_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Payment allocations are immutable and insert-only'
    USING ERRCODE = '0A000';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_allocations_immutable
  BEFORE UPDATE OR DELETE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION reject_allocation_mutation();

CREATE OR REPLACE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
