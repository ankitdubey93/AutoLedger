-- 066_stock_items.sql
-- Phase 28 — StockLedger: the item master. See docs/stock.md and
-- docs/roadmap.md#phase-28.
--
-- `attributes` is JSONB, not an entity-attribute-value table and not a
-- column per industry: a fixed column set can never cover every industry's
-- custom fields, and EAV loses type safety and needs a join per attribute
-- to filter. Validation against `stock_attribute_definitions` happens in
-- the service layer (utils/stockAttributes.ts); this table only checks the
-- JSON shape is an object. The GIN index with jsonb_path_ops serves
-- containment filters like `attributes @> '{"color":"RED"}'` cheaply. See
-- study/postgresql/jsonb-user-defined-attributes.md.
--
-- `code` is frozen once created (service layer) — it is either typed by the
-- user or generated once by `codeSchemeService.nextCodeOnClient` and never
-- changes after.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere
-- below leaves the database untouched.

CREATE TABLE IF NOT EXISTS stock_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code                TEXT NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9\-_/.]{0,39}$'),
  name                TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description         TEXT CHECK (description IS NULL OR length(description) <= 1000),
  category_id         UUID NOT NULL,
  item_type           TEXT NOT NULL CHECK (item_type IN ('RAW_MATERIAL','COMPONENT','WORK_IN_PROGRESS',
                        'FINISHED_GOOD','TRADING_GOOD','CONSUMABLE','PACKAGING','SPARE_PART','PROPERTY_UNIT')),
  tracking            TEXT NOT NULL CHECK (tracking IN ('QUANTITY','LOT','SERIAL')),
  uom_id              UUID NOT NULL,
  code_scheme_id      UUID,
  barcode             TEXT CHECK (barcode IS NULL OR barcode ~ '^[0-9]{8}$|^[0-9]{12,14}$'),
  attributes          JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
  reorder_point_milli BIGINT CHECK (reorder_point_milli IS NULL OR reorder_point_milli BETWEEN 0 AND 1000000000),
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_by          UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_stock_items_org_id_id UNIQUE (org_id, id),
  CONSTRAINT ux_stock_items_org_code  UNIQUE (org_id, code),
  CONSTRAINT fk_stock_items_category FOREIGN KEY (org_id, category_id) REFERENCES stock_categories (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_stock_items_uom      FOREIGN KEY (org_id, uom_id)      REFERENCES stock_uoms (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_stock_items_scheme   FOREIGN KEY (org_id, code_scheme_id) REFERENCES stock_code_schemes (org_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_items_org_barcode ON stock_items (org_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_items_org_active   ON stock_items (org_id, is_active, code);
CREATE INDEX IF NOT EXISTS idx_stock_items_org_category ON stock_items (org_id, category_id);
CREATE INDEX IF NOT EXISTS idx_stock_items_uom          ON stock_items (uom_id);
CREATE INDEX IF NOT EXISTS idx_stock_items_scheme       ON stock_items (code_scheme_id);
CREATE INDEX IF NOT EXISTS idx_stock_items_created_by   ON stock_items (created_by);
CREATE INDEX IF NOT EXISTS idx_stock_items_attributes   ON stock_items USING GIN (attributes jsonb_path_ops);

CREATE OR REPLACE TRIGGER trg_stock_items_updated_at
  BEFORE UPDATE ON stock_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_stock_items_audit
  AFTER INSERT OR UPDATE OR DELETE ON stock_items
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('stock');
