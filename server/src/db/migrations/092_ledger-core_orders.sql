-- 092_ledger-core_orders.sql
-- Phase 42 (Slice F) — sales and purchase orders, with partial invoicing/billing.
--
--   orders       One table, direction 'SALES' (SO-, to a customer) or
--                'PURCHASE' (PO-, to a vendor). DRAFT -> CONFIRMED ->
--                CLOSED | CANCELLED, CLOSED -> CONFIRMED (reopen). An order
--                never posts: no journal entry, no stock movement. Content is
--                immutable once CONFIRMED (trigger below).
--   order_lines  Priced lines, editable only while the order is DRAFT.
--   invoice_lines / bill_lines gain order_line_id: which order line a document
--                line bills. The billed quantity is DERIVED (sum of linked
--                lines on non-VOID documents), never stored, and capped at the
--                ordered quantity by a deferred constraint trigger.
--
-- The status CHECK and the trigger's transition list must match ORDER_STATUSES
-- and ORDER_TRANSITIONS in server/src/types/accounting.ts (rule 10).
-- Idempotent throughout; the migration test replays every file.

-- ------------------------------------------------- numbering

ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS order_prefix                 TEXT    NOT NULL DEFAULT 'SO-' CHECK (length(order_prefix) <= 12);
ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS order_next_number            INTEGER NOT NULL DEFAULT 1     CHECK (order_next_number > 0);
ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS purchase_order_prefix        TEXT    NOT NULL DEFAULT 'PO-' CHECK (length(purchase_order_prefix) <= 12);
ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS purchase_order_next_number   INTEGER NOT NULL DEFAULT 1     CHECK (purchase_order_next_number > 0);

-- --------------------------------------------------------------------- orders

CREATE TABLE IF NOT EXISTS orders (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  direction             TEXT NOT NULL CHECK (direction IN ('SALES', 'PURCHASE')),
  customer_id           UUID NULL,
  vendor_id             UUID NULL,

  -- NULL while DRAFT; allocated at confirmation so a deleted draft burns no number.
  order_number          TEXT NULL,
  status                TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'CONFIRMED', 'CLOSED', 'CANCELLED')),
  order_date            DATE NOT NULL,
  expected_date         DATE NULL CHECK (expected_date IS NULL OR expected_date >= order_date),
  currency_code         CHAR(3) NOT NULL,

  party_name_snapshot        TEXT NOT NULL,
  party_address_snapshot     TEXT NULL,
  party_tax_number_snapshot  TEXT NULL,
  party_reference       TEXT NULL CHECK (party_reference IS NULL OR length(party_reference) <= 100),
  notes                 TEXT NULL CHECK (notes IS NULL OR length(notes) <= 1000),
  terms                 TEXT NULL CHECK (terms IS NULL OR length(terms) <= 5000),
  payment_terms         TEXT NULL,
  payment_terms_code    TEXT NULL,

  subtotal_cents        BIGINT NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  tax_cents             BIGINT NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents           BIGINT NOT NULL DEFAULT 0 CHECK (total_cents >= 0),

  source_quote_id         UUID NULL,
  source_quote_direction  TEXT NULL,

  confirmed_at          TIMESTAMPTZ NULL,
  confirmed_by          UUID NULL REFERENCES users(id) ON DELETE RESTRICT,
  closed_at             TIMESTAMPTZ NULL,
  cancelled_at          TIMESTAMPTZ NULL,
  cancel_reason         TEXT NULL CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 500),

  created_by            UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_orders_org_id_id UNIQUE (org_id, id),
  CONSTRAINT ux_orders_org_id_id_direction UNIQUE (org_id, id, direction),
  CONSTRAINT ux_orders_number UNIQUE (org_id, direction, order_number),
  CONSTRAINT ck_orders_party CHECK (
    (direction = 'SALES'    AND customer_id IS NOT NULL AND vendor_id IS NULL) OR
    (direction = 'PURCHASE' AND vendor_id   IS NOT NULL AND customer_id IS NULL)
  ),
  CONSTRAINT chk_orders_total CHECK (total_cents = subtotal_cents + tax_cents),
  CONSTRAINT ck_orders_source_quote CHECK (
    (source_quote_id IS NULL AND source_quote_direction IS NULL) OR
    (source_quote_id IS NOT NULL AND source_quote_direction = direction)
  ),
  CONSTRAINT ck_orders_confirmed_complete CHECK (
    status = 'DRAFT' OR (order_number IS NOT NULL AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)
  ),
  CONSTRAINT ck_orders_closed_complete    CHECK (status <> 'CLOSED' OR closed_at IS NOT NULL),
  CONSTRAINT ck_orders_cancelled_complete CHECK (status <> 'CANCELLED' OR (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)),
  CONSTRAINT fk_orders_customer
    FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_orders_vendor
    FOREIGN KEY (org_id, vendor_id) REFERENCES vendors (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_orders_source_quote
    FOREIGN KEY (org_id, source_quote_id, source_quote_direction)
    REFERENCES quotes (org_id, id, direction) ON DELETE RESTRICT
);

-- A quote becomes at most one order.
CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_source_quote
  ON orders (org_id, source_quote_id) WHERE source_quote_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_org_direction_status_date ON orders (org_id, direction, status, order_date DESC);
CREATE INDEX IF NOT EXISTS idx_orders_customer     ON orders (org_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_vendor       ON orders (org_id, vendor_id) WHERE vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_created_by   ON orders (created_by);
CREATE INDEX IF NOT EXISTS idx_orders_confirmed_by ON orders (confirmed_by);

-- ---------------------------------------------------------------- order_lines

CREATE TABLE IF NOT EXISTS order_lines (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  order_id           UUID NOT NULL,

  line_number        SMALLINT NOT NULL CHECK (line_number > 0),
  description        TEXT NOT NULL CHECK (length(btrim(description)) > 0 AND length(description) <= 500),
  quantity_milli     BIGINT NOT NULL CHECK (quantity_milli > 0 AND quantity_milli <= 1000000000),
  unit_price_cents   BIGINT NOT NULL CHECK (unit_price_cents >= 0 AND unit_price_cents <= 1000000000000),
  account_id         UUID NOT NULL,
  tax_rate_bp        INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  net_cents          BIGINT NOT NULL CHECK (net_cents >= 0),
  tax_cents          BIGINT NOT NULL CHECK (tax_cents >= 0),
  item_id            UUID NULL,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_order_lines_order_line UNIQUE (order_id, line_number),
  CONSTRAINT ux_order_lines_org_id_id UNIQUE (org_id, id),
  CONSTRAINT fk_order_lines_order
    FOREIGN KEY (org_id, order_id) REFERENCES orders (org_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_order_lines_account
    FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_order_lines_item
    FOREIGN KEY (org_id, item_id) REFERENCES items (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_order_lines_order   ON order_lines (order_id);
CREATE INDEX IF NOT EXISTS idx_order_lines_account ON order_lines (account_id);
CREATE INDEX IF NOT EXISTS idx_order_lines_item    ON order_lines (item_id) WHERE item_id IS NOT NULL;

-- ------------------------------------------- invoice / bill line back-links

ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS order_line_id UUID NULL;
ALTER TABLE bill_lines    ADD COLUMN IF NOT EXISTS order_line_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoice_lines_order_line') THEN
    ALTER TABLE invoice_lines ADD CONSTRAINT fk_invoice_lines_order_line
      FOREIGN KEY (org_id, order_line_id) REFERENCES order_lines (org_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bill_lines_order_line') THEN
    ALTER TABLE bill_lines ADD CONSTRAINT fk_bill_lines_order_line
      FOREIGN KEY (org_id, order_line_id) REFERENCES order_lines (org_id, id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_invoice_lines_order_line ON invoice_lines (order_line_id) WHERE order_line_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bill_lines_order_line    ON bill_lines (order_line_id) WHERE order_line_id IS NOT NULL;

-- ------------------------------------------------------------------- triggers

-- Content freezes at CONFIRMED. A DRAFT changes freely and may only become
-- DRAFT or CONFIRMED; after that only the listed transitions, touching only
-- the status and its own timestamp columns.
CREATE OR REPLACE FUNCTION reject_confirmed_order_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Order % is % and cannot be deleted', OLD.id, OLD.status
        USING ERRCODE = '0A000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'DRAFT' THEN
    IF NEW.status NOT IN ('DRAFT', 'CONFIRMED') THEN
      RAISE EXCEPTION 'Order % is DRAFT and cannot become %', OLD.id, NEW.status
        USING ERRCODE = '0A000';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT (
       (OLD.status = 'CONFIRMED' AND NEW.status IN ('CLOSED', 'CANCELLED'))
    OR (OLD.status = 'CLOSED'    AND NEW.status = 'CONFIRMED')
  ) THEN
    RAISE EXCEPTION 'Order % is % and cannot become %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = '0A000';
  END IF;

  IF to_jsonb(NEW) - ARRAY['status', 'updated_at', 'closed_at', 'cancelled_at', 'cancel_reason']
     IS DISTINCT FROM
     to_jsonb(OLD) - ARRAY['status', 'updated_at', 'closed_at', 'cancelled_at', 'cancel_reason'] THEN
    RAISE EXCEPTION 'Order % is % — only its status may change', OLD.id, OLD.status
      USING ERRCODE = '0A000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_orders_immutable
  BEFORE UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION reject_confirmed_order_mutation();

CREATE OR REPLACE FUNCTION reject_non_draft_order_line_mutation() RETURNS trigger AS $$
DECLARE
  v_order_id UUID;
  v_status   TEXT;
BEGIN
  v_order_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.order_id ELSE NEW.order_id END;
  SELECT status INTO v_status FROM orders WHERE id = v_order_id;

  IF v_status IS NOT NULL AND v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Order % is % — its lines cannot be changed', v_order_id, v_status
      USING ERRCODE = '0A000';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_order_lines_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON order_lines
  FOR EACH ROW EXECUTE FUNCTION reject_non_draft_order_line_mutation();

CREATE OR REPLACE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_orders_audit
  AFTER INSERT OR UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

-- Over-billing guard: for the order line a document line points at, the
-- quantity on non-VOID invoices plus non-VOID bills may not exceed the
-- ordered quantity. Deferred to COMMIT so a transaction that voids one
-- document and raises another is judged on its final state.
CREATE OR REPLACE FUNCTION check_order_line_billing() RETURNS trigger AS $$
DECLARE
  v_line_id UUID;
  v_org_id  UUID;
  v_ordered BIGINT;
  v_billed  BIGINT;
BEGIN
  v_line_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.order_line_id ELSE NEW.order_line_id END;
  v_org_id  := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
  IF v_line_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT ol.quantity_milli INTO v_ordered
    FROM order_lines ol WHERE ol.id = v_line_id AND ol.org_id = v_org_id;
  IF v_ordered IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(q), 0) INTO v_billed FROM (
    SELECT il.quantity_milli AS q
      FROM invoice_lines il
      JOIN invoices i ON i.org_id = il.org_id AND i.id = il.invoice_id
     WHERE il.org_id = v_org_id AND il.order_line_id = v_line_id AND i.status <> 'VOID'
    UNION ALL
    SELECT bl.quantity_milli
      FROM bill_lines bl
      JOIN bills b ON b.org_id = bl.org_id AND b.id = bl.bill_id
     WHERE bl.org_id = v_org_id AND bl.order_line_id = v_line_id AND b.status <> 'VOID'
  ) s;

  IF v_billed > v_ordered THEN
    RAISE EXCEPTION 'Order line % would be billed beyond its ordered quantity', v_line_id
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Constraint triggers cannot be CREATE OR REPLACE'd: guard on pg_trigger.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_invoice_lines_order_cap') THEN
    CREATE CONSTRAINT TRIGGER trg_invoice_lines_order_cap
      AFTER INSERT OR UPDATE ON invoice_lines
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION check_order_line_billing();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_bill_lines_order_cap') THEN
    CREATE CONSTRAINT TRIGGER trg_bill_lines_order_cap
      AFTER INSERT OR UPDATE ON bill_lines
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION check_order_line_billing();
  END IF;
END $$;
