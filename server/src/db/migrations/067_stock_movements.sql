-- 067_stock_movements.sql
-- Phase 28 — StockLedger: lots, serials, the append-only movement ledger
-- and the derived balance cache. See docs/stock.md and
-- docs/roadmap.md#phase-28.
--
-- `stock_movements` is append-only by trigger, the same pattern
-- `journal_entries`/`ledger_lines` use (migration 004, guardrails rule 6):
-- a correction is a new movement, never an UPDATE or DELETE of a posted one.
--
-- `stock_balances` is a DERIVED CACHE, maintained in the same transaction
-- as each movement (movementService.ts) and verified against Σ movements by
-- the integrity script (db/integrity.ts) — the same "derived, but checked"
-- posture the GL's own balances have. It carries NO audit trigger: its
-- truth is the movement rows, and auditing a cache row on every movement
-- would double every audit entry for no informational gain.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere
-- below leaves the database untouched.

CREATE TABLE IF NOT EXISTS stock_lots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  item_id         UUID NOT NULL,
  lot_number      TEXT NOT NULL CHECK (length(btrim(lot_number)) BETWEEN 1 AND 40),
  manufactured_on DATE,
  expires_on      DATE,
  created_by      UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_stock_lots_org_id_id UNIQUE (org_id, id),
  CONSTRAINT ux_stock_lots_item_number UNIQUE (org_id, item_id, lot_number),
  CONSTRAINT fk_stock_lots_item FOREIGN KEY (org_id, item_id) REFERENCES stock_items (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT ck_stock_lots_dates CHECK (manufactured_on IS NULL OR expires_on IS NULL OR expires_on >= manufactured_on)
);

CREATE INDEX IF NOT EXISTS idx_stock_lots_org_item_expires ON stock_lots (org_id, item_id, expires_on);
CREATE INDEX IF NOT EXISTS idx_stock_lots_created_by        ON stock_lots (created_by);

CREATE TABLE IF NOT EXISTS stock_serials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  item_id       UUID NOT NULL,
  serial_number TEXT NOT NULL CHECK (length(btrim(serial_number)) BETWEEN 1 AND 60),
  status        TEXT NOT NULL CHECK (status IN ('AVAILABLE','ON_HOLD','BOOKED','ISSUED')),
  location_id   UUID,
  cost_cents    BIGINT NOT NULL CHECK (cost_cents BETWEEN 0 AND 100000000000000),
  status_note   TEXT CHECK (status_note IS NULL OR length(status_note) <= 200),
  attributes    JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
  created_by    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_stock_serials_org_id_id UNIQUE (org_id, id),
  CONSTRAINT ux_stock_serials_item_number UNIQUE (org_id, item_id, serial_number),
  CONSTRAINT fk_stock_serials_item FOREIGN KEY (org_id, item_id) REFERENCES stock_items (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_stock_serials_location FOREIGN KEY (org_id, location_id) REFERENCES stock_locations (org_id, id) ON DELETE RESTRICT,
  -- In stock <=> has a location. ISSUED serials carry no location; every other status does.
  CONSTRAINT ck_stock_serials_location CHECK ((status = 'ISSUED') = (location_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_stock_serials_org_item_status ON stock_serials (org_id, item_id, status);
CREATE INDEX IF NOT EXISTS idx_stock_serials_location         ON stock_serials (location_id);
CREATE INDEX IF NOT EXISTS idx_stock_serials_created_by       ON stock_serials (created_by);

CREATE TABLE IF NOT EXISTS stock_movements (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  movement_group_id UUID NOT NULL,
  movement_type     TEXT NOT NULL CHECK (movement_type IN ('RECEIPT','ISSUE','TRANSFER_OUT','TRANSFER_IN','ADJUSTMENT_IN','ADJUSTMENT_OUT')),
  item_id           UUID NOT NULL,
  location_id       UUID NOT NULL,
  lot_id            UUID,
  serial_id         UUID,
  quantity_milli    BIGINT NOT NULL CHECK (quantity_milli <> 0 AND abs(quantity_milli) <= 1000000000),
  value_cents       BIGINT NOT NULL CHECK (abs(value_cents) <= 100000000000000),
  reference         TEXT CHECK (reference IS NULL OR length(reference) <= 100),
  reason            TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  occurred_on       DATE NOT NULL,
  created_by        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_stock_movements_item     FOREIGN KEY (org_id, item_id)     REFERENCES stock_items (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_stock_movements_location FOREIGN KEY (org_id, location_id) REFERENCES stock_locations (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_stock_movements_lot      FOREIGN KEY (org_id, lot_id)      REFERENCES stock_lots (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_stock_movements_serial   FOREIGN KEY (org_id, serial_id)   REFERENCES stock_serials (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT ck_stock_movements_sign CHECK (
    (movement_type IN ('RECEIPT','TRANSFER_IN','ADJUSTMENT_IN') AND quantity_milli > 0 AND value_cents >= 0)
    OR (movement_type IN ('ISSUE','TRANSFER_OUT','ADJUSTMENT_OUT') AND quantity_milli < 0 AND value_cents <= 0)),
  CONSTRAINT ck_stock_movements_lot_xor_serial CHECK (lot_id IS NULL OR serial_id IS NULL),
  CONSTRAINT ck_stock_movements_serial_unit CHECK (serial_id IS NULL OR abs(quantity_milli) = 1000)
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_org_item_location_created
  ON stock_movements (org_id, item_id, location_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_org_group     ON stock_movements (org_id, movement_group_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_org_occurred  ON stock_movements (org_id, occurred_on);
CREATE INDEX IF NOT EXISTS idx_stock_movements_lot           ON stock_movements (lot_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_serial        ON stock_movements (serial_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_location      ON stock_movements (location_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_created_by    ON stock_movements (created_by);

CREATE TABLE IF NOT EXISTS stock_balances (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  item_id        UUID NOT NULL,
  location_id    UUID NOT NULL,
  lot_id         UUID,
  quantity_milli BIGINT NOT NULL DEFAULT 0 CHECK (quantity_milli >= 0),   -- negative stock refused in the DB too
  value_cents    BIGINT NOT NULL DEFAULT 0 CHECK (value_cents >= 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- PG15+: NULL lot_id rows collide with each other, so a QUANTITY item has exactly one row per location.
  CONSTRAINT ux_stock_balances_key UNIQUE NULLS NOT DISTINCT (org_id, item_id, location_id, lot_id),
  CONSTRAINT fk_stock_balances_item     FOREIGN KEY (org_id, item_id)     REFERENCES stock_items (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_stock_balances_location FOREIGN KEY (org_id, location_id) REFERENCES stock_locations (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_stock_balances_lot      FOREIGN KEY (org_id, lot_id)      REFERENCES stock_lots (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT ck_stock_balances_empty_has_no_value CHECK (quantity_milli > 0 OR value_cents = 0)
);

CREATE INDEX IF NOT EXISTS idx_stock_balances_org_location ON stock_balances (org_id, location_id);
CREATE INDEX IF NOT EXISTS idx_stock_balances_lot          ON stock_balances (lot_id);

CREATE OR REPLACE FUNCTION reject_stock_movement_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'stock movements are append-only; post a correcting adjustment instead (guardrails rule 6)'
    USING ERRCODE = '0A000';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_stock_movements_immutable
  BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION reject_stock_movement_mutation();

CREATE OR REPLACE TRIGGER trg_stock_serials_updated_at
  BEFORE UPDATE ON stock_serials FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_stock_balances_updated_at
  BEFORE UPDATE ON stock_balances FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_stock_lots_audit
  AFTER INSERT OR UPDATE OR DELETE ON stock_lots
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('stock');
CREATE OR REPLACE TRIGGER trg_stock_serials_audit
  AFTER INSERT OR UPDATE OR DELETE ON stock_serials
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('stock');
CREATE OR REPLACE TRIGGER trg_stock_movements_audit
  AFTER INSERT OR UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('stock');
