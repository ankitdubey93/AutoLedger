-- 060_ledger-core_reference_data_cascade.sql
-- Fixes a real defect found while building Phase 20 (guardrail-review):
-- migrations 058 (payment_terms) and 059 (items) declared `org_id ...
-- REFERENCES organizations(id) ON DELETE RESTRICT`, copying the pattern used
-- by documents that post to the ledger (invoices, bills, journal_entries,
-- fiscal_periods, payments, migration_imports, fx_revaluations) — tables
-- whose RESTRICT exists specifically so a still-posted document cannot have
-- its organization pulled out from under it.
--
-- `payment_terms` and `items` are reference/lookup data, the same kind as
-- `accounts`, `customers` and `vendors` — all of which use ON DELETE CASCADE.
-- RESTRICT here served no purpose and broke `DELETE FROM organizations`
-- everywhere else in the codebase relies on cascade to clean up (six
-- unrelated test suites failed on this before the fix). 058 and 059 are
-- already applied, so per rule 13 they are not edited — this corrects them
-- forward instead.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere
-- below leaves the database untouched.

ALTER TABLE payment_terms DROP CONSTRAINT IF EXISTS payment_terms_org_id_fkey;
ALTER TABLE payment_terms ADD CONSTRAINT payment_terms_org_id_fkey
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;

ALTER TABLE items DROP CONSTRAINT IF EXISTS items_org_id_fkey;
ALTER TABLE items ADD CONSTRAINT items_org_id_fkey
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
