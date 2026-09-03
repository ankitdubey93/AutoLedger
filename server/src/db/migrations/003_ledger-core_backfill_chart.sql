-- 003_ledger-core_backfill_chart.sql
-- Phase 3 — LedgerCore. Seeds the default chart of accounts for organizations
-- that predate it. See docs/schema.md#default-chart-of-accounts.
--
-- WHY THIS FILE EXISTS
-- `authService.register` seeds the chart from Phase 3 onward, but every
-- organization created during Phases 1-2 has zero accounts and would be unable
-- to post anything. Adding the seed to `register` alone is therefore not
-- sufficient — the roadmap records this backfill as debt Phase 3 owes.
--
-- The account list below is GENERATED from DEFAULT_CHART in
-- src/services/ledger-core/accountService.ts. If the chart ever changes, this
-- file is NOT edited (rule 13 — it is applied and checksummed): write a new
-- migration for the delta.
--
-- Idempotent twice over: it targets only organizations that currently have no
-- accounts at all, and every INSERT carries ON CONFLICT DO NOTHING. On a fresh
-- database it correctly inserts nothing, because there are no organizations yet.

-- The set of organizations to seed has to be captured BEFORE the first insert.
-- A `NOT EXISTS (SELECT 1 FROM accounts ...)` predicate repeated on each of the
-- three statements below would match nothing after the first one ran, since the
-- organization now has its root accounts. A temp table freezes the list.
--
-- ON COMMIT DROP: the runner applies each migration in one transaction on one
-- long-lived client, so the table must not outlive this file.
CREATE TEMP TABLE backfill_target_orgs ON COMMIT DROP AS
  SELECT o.id AS org_id
    FROM organizations o
   WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id);

-- One statement per tree depth: a parent's id is resolved by a correlated
-- subquery against rows the previous statement inserted, and a statement cannot
-- see the rows it is inserting itself.

-- depth 0 (6 accounts)
INSERT INTO accounts (org_id, code, name, type, is_postable, parent_id)
SELECT t.org_id, v.code, v.name, v.type, v.is_postable,
       (SELECT p.id FROM accounts p WHERE p.org_id = t.org_id AND p.code = v.parent_code)
  FROM backfill_target_orgs t
  CROSS JOIN (VALUES
    ('1000', 'Assets', 'Asset', false, NULL::text),
    ('2000', 'Liabilities', 'Liability', false, NULL::text),
    ('3000', 'Equity', 'Equity', false, NULL::text),
    ('4000', 'Revenue', 'Revenue', false, NULL::text),
    ('5000', 'Cost of Goods Sold', 'Expense', false, NULL::text),
    ('6000', 'Operating Expenses', 'Expense', false, NULL::text)
  ) AS v(code, name, type, is_postable, parent_code)
ON CONFLICT (org_id, code) DO NOTHING;

-- depth 1 (26 accounts)
INSERT INTO accounts (org_id, code, name, type, is_postable, parent_id)
SELECT t.org_id, v.code, v.name, v.type, v.is_postable,
       (SELECT p.id FROM accounts p WHERE p.org_id = t.org_id AND p.code = v.parent_code)
  FROM backfill_target_orgs t
  CROSS JOIN (VALUES
    ('1100', 'Current Assets', 'Asset', false, '1000'),
    ('1400', 'Non-Current Assets', 'Asset', false, '1000'),
    ('2010', 'Current Liabilities', 'Liability', false, '2000'),
    ('2500', 'Non-Current Liabilities', 'Liability', false, '2000'),
    ('3100', 'Common Stock / Owner''s Capital', 'Equity', true, '3000'),
    ('3200', 'Retained Earnings', 'Equity', true, '3000'),
    ('3300', 'Owner''s Draw', 'Equity', true, '3000'),
    ('4100', 'Product Revenue', 'Revenue', true, '4000'),
    ('4200', 'Service Revenue', 'Revenue', true, '4000'),
    ('4800', 'Sales Returns & Allowances', 'Revenue', true, '4000'),
    ('4910', 'Realized FX Gain', 'Revenue', true, '4000'),
    ('5100', 'Direct Materials', 'Expense', true, '5000'),
    ('5200', 'Direct Labor', 'Expense', true, '5000'),
    ('5300', 'Freight & Duty', 'Expense', true, '5000'),
    ('6100', 'Salaries & Wages', 'Expense', true, '6000'),
    ('6110', 'Rent & Utilities', 'Expense', true, '6000'),
    ('6120', 'Software & IT Infrastructure', 'Expense', true, '6000'),
    ('6130', 'Office Supplies', 'Expense', true, '6000'),
    ('6140', 'Kitchen & Breakroom', 'Expense', true, '6000'),
    ('6200', 'Professional Fees', 'Expense', true, '6000'),
    ('6300', 'Travel & Entertainment', 'Expense', true, '6000'),
    ('6400', 'Marketing & Advertising', 'Expense', true, '6000'),
    ('6500', 'Depreciation Expense', 'Expense', true, '6000'),
    ('6600', 'Bank Fees', 'Expense', true, '6000'),
    ('6810', 'Realized FX Loss', 'Expense', true, '6000'),
    ('6820', 'Unrealized FX Gain/Loss', 'Expense', true, '6000')
  ) AS v(code, name, type, is_postable, parent_code)
ON CONFLICT (org_id, code) DO NOTHING;

-- depth 2 (12 accounts)
INSERT INTO accounts (org_id, code, name, type, is_postable, parent_id)
SELECT t.org_id, v.code, v.name, v.type, v.is_postable,
       (SELECT p.id FROM accounts p WHERE p.org_id = t.org_id AND p.code = v.parent_code)
  FROM backfill_target_orgs t
  CROSS JOIN (VALUES
    ('1110', 'Operating Cash', 'Asset', true, '1100'),
    ('1120', 'Accounts Receivable', 'Asset', true, '1100'),
    ('1130', 'Prepaid Expenses', 'Asset', true, '1100'),
    ('1140', 'Inventory', 'Asset', true, '1100'),
    ('1180', 'GST/VAT Input Credit', 'Asset', true, '1100'),
    ('1500', 'Fixed Assets / Equipment', 'Asset', true, '1400'),
    ('1590', 'Accumulated Depreciation', 'Asset', true, '1400'),
    ('2100', 'Accounts Payable', 'Liability', true, '2010'),
    ('2120', 'Accrued Liabilities', 'Liability', true, '2010'),
    ('2140', 'GST/VAT Output Payable', 'Liability', true, '2010'),
    ('2160', 'Payroll Liabilities', 'Liability', true, '2010'),
    ('2510', 'Notes Payable', 'Liability', true, '2500')
  ) AS v(code, name, type, is_postable, parent_code)
ON CONFLICT (org_id, code) DO NOTHING;

