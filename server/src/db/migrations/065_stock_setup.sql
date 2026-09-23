-- 065_stock_setup.sql
-- Phase 28 — StockLedger: per-organization setup and catalogue configuration
-- (industry choice, units of measure, categories, custom-field definitions,
-- item-code schemes and their counters, and locations). See docs/stock.md
-- and docs/roadmap.md#phase-28.
--
-- Every table carries org_id (guardrails rule 1) and every `*_id` is FK'd
-- with an explicit ON DELETE and indexed (rule 8) — composite (org_id, id)
-- foreign keys prevent one organization's row from ever referencing
-- another's. There is NO general-ledger posting anywhere in this phase:
-- StockLedger tracks quantity and value on its own, and connecting it to
-- LedgerCore's GL (rule 16 — cross-app effects go through journalService,
-- never a direct query) is future work, not part of Phase 28.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere
-- below leaves the database untouched.

CREATE TABLE IF NOT EXISTS stock_settings (
  org_id           UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  industry_profile TEXT NOT NULL CHECK (industry_profile IN ('GENERAL','RETAIL','WHOLESALE_DISTRIBUTION',
                     'MANUFACTURING','FOOD_BEVERAGE','PHARMA_HEALTHCARE','APPAREL_FOOTWEAR','ELECTRONICS',
                     'AUTOMOTIVE','REAL_ESTATE')),
  created_by       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_settings_created_by ON stock_settings (created_by);

CREATE TABLE IF NOT EXISTS stock_uoms (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code           TEXT NOT NULL CHECK (code ~ '^[A-Z0-9]{1,10}$'),
  name           TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  decimal_places SMALLINT NOT NULL CHECK (decimal_places BETWEEN 0 AND 3),
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_by     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_stock_uoms_org_id_id UNIQUE (org_id, id),
  CONSTRAINT ux_stock_uoms_org_code  UNIQUE (org_id, code)
);

CREATE INDEX IF NOT EXISTS idx_stock_uoms_org_active ON stock_uoms (org_id, is_active, code);
CREATE INDEX IF NOT EXISTS idx_stock_uoms_created_by  ON stock_uoms (created_by);

CREATE TABLE IF NOT EXISTS stock_categories (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_id        UUID,
  code             TEXT NOT NULL CHECK (code ~ '^[A-Z0-9]{2,10}$'),
  name             TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  item_type        TEXT NOT NULL CHECK (item_type IN ('RAW_MATERIAL','COMPONENT','WORK_IN_PROGRESS',
                     'FINISHED_GOOD','TRADING_GOOD','CONSUMABLE','PACKAGING','SPARE_PART','PROPERTY_UNIT')),
  default_tracking TEXT NOT NULL CHECK (default_tracking IN ('QUANTITY','LOT','SERIAL')),
  default_uom_id   UUID,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_by       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_stock_categories_org_id_id UNIQUE (org_id, id),
  CONSTRAINT ux_stock_categories_org_code  UNIQUE (org_id, code),
  -- Categories are frozen once created (service layer): code, parent_id,
  -- item_type and default_tracking never change, so a parent cycle is
  -- structurally impossible without ever needing a cycle check here.
  CONSTRAINT fk_stock_categories_parent FOREIGN KEY (org_id, parent_id)
    REFERENCES stock_categories (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_stock_categories_default_uom FOREIGN KEY (org_id, default_uom_id)
    REFERENCES stock_uoms (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_stock_categories_org_active   ON stock_categories (org_id, is_active, code);
CREATE INDEX IF NOT EXISTS idx_stock_categories_org_parent   ON stock_categories (org_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_stock_categories_default_uom  ON stock_categories (default_uom_id);
CREATE INDEX IF NOT EXISTS idx_stock_categories_created_by   ON stock_categories (created_by);

CREATE TABLE IF NOT EXISTS stock_attribute_definitions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  category_id    UUID NOT NULL,
  applies_to     TEXT NOT NULL CHECK (applies_to IN ('ITEM','SERIAL')),
  key            TEXT NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label          TEXT NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  data_type      TEXT NOT NULL CHECK (data_type IN ('TEXT','NUMBER','DATE','BOOLEAN','SELECT')),
  options        JSONB,
  decimal_places SMALLINT CHECK (decimal_places IS NULL OR decimal_places BETWEEN 0 AND 4),
  is_required    BOOLEAN NOT NULL DEFAULT false,
  sort_order     SMALLINT NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 999),
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_by     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_stock_attr_defs_key UNIQUE (org_id, category_id, applies_to, key),
  CONSTRAINT fk_stock_attr_defs_category FOREIGN KEY (org_id, category_id)
    REFERENCES stock_categories (org_id, id) ON DELETE CASCADE,
  -- SELECT attributes carry 1-50 options; every other type carries none.
  -- The service layer (utils/stockAttributes.ts) does the real per-value
  -- validation; this CHECK only guards the definition's own shape.
  CONSTRAINT ck_stock_attr_defs_options CHECK (
    (data_type = 'SELECT' AND options IS NOT NULL AND jsonb_typeof(options) = 'array'
       AND jsonb_array_length(options) BETWEEN 1 AND 50)
    OR (data_type <> 'SELECT' AND options IS NULL)),
  CONSTRAINT ck_stock_attr_defs_decimals CHECK (
    (data_type = 'NUMBER' AND decimal_places IS NOT NULL) OR (data_type <> 'NUMBER' AND decimal_places IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_stock_attr_defs_org_category ON stock_attribute_definitions (org_id, category_id);
CREATE INDEX IF NOT EXISTS idx_stock_attr_defs_created_by   ON stock_attribute_definitions (created_by);

CREATE TABLE IF NOT EXISTS stock_code_schemes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  pattern    TEXT NOT NULL CHECK (length(pattern) BETWEEN 1 AND 60),
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_stock_code_schemes_org_id_id UNIQUE (org_id, id),
  CONSTRAINT ux_stock_code_schemes_org_name  UNIQUE (org_id, name),
  CONSTRAINT ck_stock_code_schemes_default_active CHECK (NOT is_default OR is_active)
);

CREATE INDEX IF NOT EXISTS idx_stock_code_schemes_org_active ON stock_code_schemes (org_id, is_active);
CREATE INDEX IF NOT EXISTS idx_stock_code_schemes_created_by ON stock_code_schemes (created_by);

-- At most one default scheme per org: a partial unique index
-- (study/postgresql/partial-unique-indexes.md).
CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_code_schemes_one_default
  ON stock_code_schemes (org_id) WHERE is_default;

-- Counter rows: one per (scheme, rendered scope key — the pattern with its
-- {SEQ:n} replaced by '#'). No updated_at, no audit trigger: a counter bump
-- is not a business event, and auditing it would add a row per item created.
CREATE TABLE IF NOT EXISTS stock_code_counters (
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scheme_id  UUID NOT NULL,
  scope_key  TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 60),
  next_value BIGINT NOT NULL CHECK (next_value >= 1),
  PRIMARY KEY (org_id, scheme_id, scope_key),
  CONSTRAINT fk_stock_code_counters_scheme FOREIGN KEY (org_id, scheme_id)
    REFERENCES stock_code_schemes (org_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS stock_locations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_id  UUID,
  code       TEXT NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9\-]{0,19}$'),
  name       TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  kind       TEXT NOT NULL CHECK (kind IN ('WAREHOUSE','STORE','SITE','ZONE','BIN')),
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_stock_locations_org_id_id UNIQUE (org_id, id),
  CONSTRAINT ux_stock_locations_org_code  UNIQUE (org_id, code),
  CONSTRAINT fk_stock_locations_parent FOREIGN KEY (org_id, parent_id)
    REFERENCES stock_locations (org_id, id) ON DELETE RESTRICT,
  -- A WAREHOUSE/STORE/SITE is always top-level; a ZONE/BIN always sits
  -- inside another location. The service layer checks this before insert;
  -- this CHECK is the backstop.
  CONSTRAINT ck_stock_locations_top_level CHECK (
    (parent_id IS NULL AND kind IN ('WAREHOUSE','STORE','SITE'))
    OR (parent_id IS NOT NULL AND kind IN ('ZONE','BIN')))
);

CREATE INDEX IF NOT EXISTS idx_stock_locations_org_active ON stock_locations (org_id, is_active, code);
CREATE INDEX IF NOT EXISTS idx_stock_locations_org_parent ON stock_locations (org_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_stock_locations_created_by ON stock_locations (created_by);

CREATE OR REPLACE TRIGGER trg_stock_settings_updated_at
  BEFORE UPDATE ON stock_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_stock_uoms_updated_at
  BEFORE UPDATE ON stock_uoms FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_stock_categories_updated_at
  BEFORE UPDATE ON stock_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_stock_attribute_definitions_updated_at
  BEFORE UPDATE ON stock_attribute_definitions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_stock_code_schemes_updated_at
  BEFORE UPDATE ON stock_code_schemes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_stock_locations_updated_at
  BEFORE UPDATE ON stock_locations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_stock_settings_audit
  AFTER INSERT OR UPDATE OR DELETE ON stock_settings
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('stock');
CREATE OR REPLACE TRIGGER trg_stock_uoms_audit
  AFTER INSERT OR UPDATE OR DELETE ON stock_uoms
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('stock');
CREATE OR REPLACE TRIGGER trg_stock_categories_audit
  AFTER INSERT OR UPDATE OR DELETE ON stock_categories
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('stock');
CREATE OR REPLACE TRIGGER trg_stock_attribute_definitions_audit
  AFTER INSERT OR UPDATE OR DELETE ON stock_attribute_definitions
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('stock');
CREATE OR REPLACE TRIGGER trg_stock_code_schemes_audit
  AFTER INSERT OR UPDATE OR DELETE ON stock_code_schemes
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('stock');
CREATE OR REPLACE TRIGGER trg_stock_locations_audit
  AFTER INSERT OR UPDATE OR DELETE ON stock_locations
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('stock');
