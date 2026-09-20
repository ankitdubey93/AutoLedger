-- 058_ledger-core_payment_terms.sql
-- Phase 20 — LedgerCore payment terms: a selectable, org-owned catalogue that
-- an invoice or bill's due date can be derived from instead of typed by hand.
-- See docs/schema.md and docs/roadmap.md#phase-20-as-delivered.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.

CREATE TABLE IF NOT EXISTS payment_terms (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  code        TEXT NOT NULL CHECK (code ~ '^[A-Z0-9_]{2,30}$'),
  name        TEXT NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 60),
  net_days    SMALLINT NOT NULL CHECK (net_days BETWEEN 0 AND 365),

  -- true for the seven standards. A system term may be deactivated but its
  -- code, name and net_days are frozen — the service refuses those edits.
  is_system   BOOLEAN NOT NULL DEFAULT false,
  is_active   BOOLEAN NOT NULL DEFAULT true,

  -- NULL means "seeded by the platform", not "unknown user": the backfill
  -- below has no acting user to attribute the row to.
  created_by  UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_payment_terms_org_id_id UNIQUE (org_id, id),
  CONSTRAINT ux_payment_terms_org_code  UNIQUE (org_id, code)
);

CREATE INDEX IF NOT EXISTS idx_payment_terms_org_active ON payment_terms (org_id, is_active, net_days);
CREATE INDEX IF NOT EXISTS idx_payment_terms_created_by ON payment_terms (created_by);

CREATE OR REPLACE TRIGGER trg_payment_terms_updated_at
  BEFORE UPDATE ON payment_terms
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Backfill: every organization that already exists gets the standards.
-- ON CONFLICT DO NOTHING makes re-application a no-op (rule 13).
INSERT INTO payment_terms (org_id, code, name, net_days, is_system)
SELECT o.id, t.code, t.name, t.net_days, true
  FROM organizations o
  CROSS JOIN (VALUES
    ('DUE_ON_RECEIPT', 'Due on receipt', 0),
    ('NET_7',  'Net 7',  7),
    ('NET_15', 'Net 15', 15),
    ('NET_30', 'Net 30', 30),
    ('NET_45', 'Net 45', 45),
    ('NET_60', 'Net 60', 60),
    ('NET_90', 'Net 90', 90)
  ) AS t(code, name, net_days)
ON CONFLICT (org_id, code) DO NOTHING;

-- Snapshot of the chosen term's code on the document. No FK, deliberately:
-- a posted document is immutable (rule 6), so a later rename or
-- deactivation of the term must not be able to reach it.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_terms_code TEXT;
ALTER TABLE bills    ADD COLUMN IF NOT EXISTS payment_terms_code TEXT;
