-- 059_ledger-core_items.sql
-- Phase 20 — LedgerCore items: a catalogue of products/services an invoice or
-- bill line can be picked from. This is a CATALOGUE, not inventory: there is
-- no on-hand quantity, no stock movement, no COGS posting and no inventory
-- valuation — those are a subsystem of their own and are deliberately not
-- built in this phase. See docs/schema.md and docs/roadmap.md#phase-20-as-delivered.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.

CREATE TABLE IF NOT EXISTS items (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  code                  TEXT NOT NULL CHECK (length(btrim(code)) > 0 AND length(code) <= 40),
  name                  TEXT NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 200),
  description           TEXT CHECK (description IS NULL OR length(description) <= 500),
  kind                  TEXT NOT NULL CHECK (kind IN ('SERVICE', 'GOODS')),

  sale_price_cents      BIGINT CHECK (sale_price_cents IS NULL
                          OR (sale_price_cents >= 0 AND sale_price_cents <= 1000000000000)),
  purchase_price_cents  BIGINT CHECK (purchase_price_cents IS NULL
                          OR (purchase_price_cents >= 0 AND purchase_price_cents <= 1000000000000)),

  revenue_account_id    UUID,
  expense_account_id    UUID,

  sale_tax_rate_bp      INTEGER NOT NULL DEFAULT 0 CHECK (sale_tax_rate_bp BETWEEN 0 AND 10000),
  purchase_tax_rate_bp  INTEGER NOT NULL DEFAULT 0 CHECK (purchase_tax_rate_bp BETWEEN 0 AND 10000),

  is_active             BOOLEAN NOT NULL DEFAULT true,
  created_by            UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_items_org_id_id UNIQUE (org_id, id),
  CONSTRAINT ux_items_org_code  UNIQUE (org_id, code),

  -- A composite FK on a nullable column is satisfied when the column is
  -- NULL — intended, and how fk_invoices_journal_entry already behaves.
  CONSTRAINT fk_items_revenue_account
    FOREIGN KEY (org_id, revenue_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_items_expense_account
    FOREIGN KEY (org_id, expense_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_items_org_active     ON items (org_id, is_active, code);
CREATE INDEX IF NOT EXISTS idx_items_revenue_account ON items (revenue_account_id);
CREATE INDEX IF NOT EXISTS idx_items_expense_account ON items (expense_account_id);
CREATE INDEX IF NOT EXISTS idx_items_created_by      ON items (created_by);

CREATE OR REPLACE TRIGGER trg_items_updated_at
  BEFORE UPDATE ON items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
