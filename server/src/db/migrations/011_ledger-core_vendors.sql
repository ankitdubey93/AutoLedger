-- 011_ledger-core_vendors.sql
-- Phase 3.9 — LedgerCore vendors, the parties bills are entered against.
-- See docs/schema.md and docs/ledger-core.md#phase-39--accounts-payable.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.

CREATE TABLE IF NOT EXISTS vendors (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The tenant boundary (guardrails rule 1). CASCADE: a vendor list is
  -- meaningless without its organization, matching customers (008).
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  name            TEXT NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 200),
  email           TEXT CHECK (email IS NULL OR length(email) <= 254),
  phone           TEXT CHECK (phone IS NULL OR length(phone) <= 40),
  billing_address TEXT,
  tax_number      TEXT CHECK (tax_number IS NULL OR length(tax_number) <= 64),
  payment_terms   TEXT CHECK (payment_terms IS NULL OR length(payment_terms) <= 500),
  notes           TEXT,
  -- Retired with is_active = false, matching customers — there is no DELETE
  -- route once a vendor may be referenced by a bill.
  is_active       BOOLEAN NOT NULL DEFAULT true,

  created_by      UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Lets bills carry a composite (org_id, vendor_id) FK, the same reasoning
  -- as ux_customers_org_id_id (008).
  CONSTRAINT ux_vendors_org_id_id UNIQUE (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_vendors_org_name   ON vendors (org_id, name);
CREATE INDEX IF NOT EXISTS idx_vendors_created_by ON vendors (created_by);

CREATE OR REPLACE TRIGGER trg_vendors_updated_at
  BEFORE UPDATE ON vendors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
