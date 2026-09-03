-- 008_ledger-core_customers.sql
-- Phase 3.8 — LedgerCore customers, the parties sales invoices are issued to.
-- See docs/schema.md and docs/ledger-core.md#phase-38--sales-invoicing.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.

CREATE TABLE IF NOT EXISTS customers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The tenant boundary (guardrails rule 1). CASCADE: a customer list is
  -- meaningless without its organization, matching accounts (002).
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  name            TEXT NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 200),
  email           TEXT CHECK (email IS NULL OR length(email) <= 254),
  phone           TEXT CHECK (phone IS NULL OR length(phone) <= 40),
  billing_address TEXT,
  tax_number      TEXT CHECK (tax_number IS NULL OR length(tax_number) <= 64),
  notes           TEXT,
  -- Retired with is_active = false, matching accounts — there is no DELETE
  -- route once a customer may be referenced by an invoice.
  is_active       BOOLEAN NOT NULL DEFAULT true,

  created_by      UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Lets invoices carry a composite (org_id, customer_id) FK, the same
  -- reasoning as ux_accounts_org_id_id (005).
  CONSTRAINT ux_customers_org_id_id UNIQUE (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_customers_org_name ON customers (org_id, name);
CREATE INDEX IF NOT EXISTS idx_customers_created_by ON customers (created_by);

CREATE OR REPLACE TRIGGER trg_customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
