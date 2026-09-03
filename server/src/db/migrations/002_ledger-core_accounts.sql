-- 002_ledger-core_accounts.sql
-- Phase 3 — LedgerCore, the chart of accounts. See docs/schema.md and
-- docs/ledger-core.md.
--
-- First app-tagged migration: NNN_<app-slug>_<subject>.sql. LedgerCore's tables
-- are unprefixed (`accounts`, not `ledger_core_accounts`) because it is the
-- shared system of record every other app posts into, the same reason
-- `organizations` and `users` are unprefixed. Every other app prefixes its own
-- tables with its slug (docs/schema.md#table-naming-across-apps).
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.

-- ------------------------------------------------------------------- accounts

CREATE TABLE IF NOT EXISTS accounts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The tenant boundary (guardrails rule 1). CASCADE because a chart of
  -- accounts is meaningless without its organization — unlike journal_entries
  -- in 004, which uses RESTRICT so posted books cannot be deleted at all.
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  code        TEXT NOT NULL CHECK (length(btrim(code)) > 0),
  name        TEXT NOT NULL CHECK (length(btrim(name)) > 0),

  -- Exactly five, forever (guardrails rule 12). Mirrored by ACCOUNT_TYPES in
  -- src/types/ledger-core.ts, which also feeds the zod enum — belt and braces.
  -- Cost of Goods Sold is NOT a sixth type: COGS accounts are 'Expense',
  -- separated from operating expenses by the 5xxx code range and by parent_id.
  type        TEXT NOT NULL CHECK (type IN ('Asset', 'Liability', 'Equity', 'Revenue', 'Expense')),

  -- Self-referencing FK: the chart is a tree.
  --   1000 Assets -> 1100 Current Assets -> 1110 Operating Cash
  -- RESTRICT, not CASCADE: deleting a parent must never silently delete the
  -- children posted against it. An account is retired with is_active = false.
  --
  -- Two rules this column cannot express on its own are enforced in
  -- accountService and covered by tests: a parent must belong to the SAME
  -- organization and carry the SAME type, and the graph must stay acyclic
  -- (checked with a WITH RECURSIVE walk before a re-parent is accepted).
  -- A single-row CHECK can only see one row, which is why the constraint below
  -- catches nothing more than the trivial self-parent case.
  parent_id   UUID REFERENCES accounts(id) ON DELETE RESTRICT,

  -- Separates header accounts from leaves. `1000 Assets` is a reporting rollup
  -- and must never receive a posting; `1110 Operating Cash` must. Enforced on
  -- the way in by a trigger on ledger_lines in 004, not merely by convention.
  is_postable BOOLEAN NOT NULL DEFAULT true,

  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,

  -- Nullable on purpose: the default chart is seeded by the system inside the
  -- registration transaction, and by the backfill in 003, where there is no
  -- acting user. RESTRICT because this is an audit reference — a user who
  -- created an account cannot be deleted out from under it.
  created_by  UUID REFERENCES users(id) ON DELETE RESTRICT,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Two organizations may both own account code 1110 and never see each
  -- other's. Uniqueness is per tenant, never global.
  CONSTRAINT ux_accounts_org_code UNIQUE (org_id, code),

  CONSTRAINT chk_account_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id)
);

-- Covers "the children of this account, in this org" — the query that builds
-- the tree for GET /accounts?tree=true.
CREATE INDEX IF NOT EXISTS idx_accounts_org_parent ON accounts (org_id, parent_id);

-- Rule 8: index every FK used in a join. The recursive ancestor walk in
-- accountService joins on parent_id without an org_id prefix on the join key.
CREATE INDEX IF NOT EXISTS idx_accounts_parent_id ON accounts (parent_id);

-- ------------------------------------------------------------------- triggers

-- Reuses the shared function from 001 rather than defining a second one
-- (docs/schema.md#migration-rules).
CREATE OR REPLACE TRIGGER trg_accounts_updated_at
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
