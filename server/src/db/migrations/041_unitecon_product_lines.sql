-- 041_unitecon_product_lines.sql
-- Phase 14 — UnitEcon: the PVM product dimension. See docs/unitecon.md and
-- docs/roadmap.md#phase-14.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.
--
-- THE DELIBERATE RULING: the product dimension IS the revenue account.
-- UnitEcon does not classify invoice_lines.description, which is free text and
-- not a key. A product line is an organization's opt-in registration of one
-- postable Revenue account as a PVM dimension, with a display name and a unit
-- label. PVM therefore decomposes at revenue-account grain and no finer;
-- SKU-level decomposition is a stated scope gap, not an oversight.
--
-- No REFERENCES accounts on revenue_account_id — rules 8 and 16 collide, 16
-- wins (migrations 032, 034, 037, 038, 039, 040). productLineService validates
-- the id through accountService.getAccountById.

CREATE TABLE IF NOT EXISTS unitecon_product_lines (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- No REFERENCES accounts — see this file's header.
  revenue_account_id UUID NOT NULL,
  name               TEXT NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 120),
  unit_label         TEXT NOT NULL DEFAULT '' CHECK (length(unit_label) <= 40),
  is_active          BOOLEAN NOT NULL DEFAULT true,

  created_by         UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One product line per revenue account: two lines over the same account
  -- would double-count every unit in the decomposition.
  CONSTRAINT ux_unitecon_product_lines_account UNIQUE (org_id, revenue_account_id),
  CONSTRAINT ux_unitecon_product_lines_name    UNIQUE (org_id, name),
  CONSTRAINT ux_unitecon_product_lines_org_id_id UNIQUE (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_unitecon_product_lines_org_name
  ON unitecon_product_lines (org_id, name);
CREATE INDEX IF NOT EXISTS idx_unitecon_product_lines_created_by
  ON unitecon_product_lines (created_by);

CREATE OR REPLACE TRIGGER trg_unitecon_product_lines_updated
  BEFORE UPDATE ON unitecon_product_lines FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_unitecon_product_lines_audit
  AFTER INSERT OR UPDATE OR DELETE ON unitecon_product_lines
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('unitecon');
