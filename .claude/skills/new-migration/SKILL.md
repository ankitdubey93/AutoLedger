---
name: new-migration
description: Write a new PostgreSQL migration for AutoLedger — correct sequential prefix, org_id scoping, FK/ON DELETE, CHECK constraints, BIGINT cents, indexes, idempotency — then verify it applies twice and sync docs/schema.md. Use whenever a table, column, index, constraint, trigger, or extension is being added or changed.
---

# Writing a migration

Migrations are the hardest thing to fix after the fact — an applied migration is frozen. Do the checks before writing, not after.

## 1. Locate the next number

```bash
ls server/src/db/migrations/
```

Next file = highest existing prefix + 1, 3 digits, descriptive snake_case suffix:
`003_inventory_stock.sql`. No gaps. No branches. `server/src/db/migrations/` is the **only** migration directory — if you find SQL anywhere else, stop and report it.

## 2. Decide: new file or edit?

| Situation | Action |
|---|---|
| Migration never applied anywhere (not committed, not run) | Editing it is fine |
| Migration is committed or has been applied | **New file, always.** Never edit it |
| Change is destructive (DROP COLUMN, type narrowing, DROP TABLE, NOT NULL on existing data) | **Stop. Ask for explicit sign-off before writing.** Say exactly what data is at risk |

## 3. Write it

Read [docs/schema.md](../../../docs/schema.md) for the target definition of the table first — it may already be specified there.

Skeleton for a domain table:

```sql
-- 00N_<name>.sql

CREATE TABLE IF NOT EXISTS <table> (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  <domain columns>,
  amount_cents BIGINT NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_<table>_org        ON <table> (org_id);
CREATE INDEX IF NOT EXISTS idx_<table>_org_<fk>   ON <table> (org_id, <fk>_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_<table>_org_code ON <table> (org_id, code);

DROP TRIGGER IF EXISTS trg_<table>_updated_at ON <table>;
CREATE TRIGGER trg_<table>_updated_at
  BEFORE UPDATE ON <table>
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

`set_updated_at()` is defined once (migration 001). Reuse it — never define a second copy.

## 4. Checklist — every line must pass

- [ ] `org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE ...` present. The only org-less tables are `users`, `refresh_tokens`, and the migration ledger — anything else needs a stated reason.
- [ ] Every `*_id` column has a real `REFERENCES` with an **explicit** `ON DELETE` (`CASCADE` for children of the org/parent doc, `RESTRICT` for audit references like `created_by`). No bare UUIDs.
- [ ] Every money column is `BIGINT` named `*_cents`. Zero `DECIMAL`, zero `NUMERIC`, zero `MONEY`, zero `REAL`/`DOUBLE`.
- [ ] Index on `org_id`, on every FK used in a join, and on the columns of every list query's `ORDER BY`/filter.
- [ ] Uniqueness that must hold per tenant is `(org_id, x)` — never `x` alone.
- [ ] Business invariants have CHECK constraints, not just service validation. Both, always.
- [ ] `IF NOT EXISTS` / `IF EXISTS` / `DROP TRIGGER ... ; CREATE TRIGGER` so a re-run is a no-op.
- [ ] Status columns: `TEXT NOT NULL CHECK (status IN (...))` matching the FSM table in code exactly.
- [ ] Account `type` columns allow exactly `Asset`, `Liability`, `Equity`, `Revenue`, `Expense`. Never a sixth.
- [ ] A new extension (`pg_trgm`, `btree_gist`) is `CREATE EXTENSION IF NOT EXISTS` in its own migration, and its phase has actually been reached.

## 5. Verify — do not skip

```bash
cd server && npm run migrate        # applies clean
cd server && npm run migrate        # second run must be a silent no-op
```

If a migration runner or DB does not exist yet (pre-Phase 0/1), say so plainly instead of claiming the migration was verified.

Then confirm the constraints actually bite — an integration test that inserts a bad row and expects rejection is the proof. See the `isolation-test` skill.

## 6. Sync docs in the same pass

Update [docs/schema.md](../../../docs/schema.md): table definition, constraint names, indexes. If the migration completes a roadmap phase item, update [docs/roadmap.md](../../../docs/roadmap.md) too.

A schema doc that describes a table you did not create is the exact failure mode that killed the prior build.
