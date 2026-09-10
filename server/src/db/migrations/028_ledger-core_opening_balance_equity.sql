-- 028_ledger-core_opening_balance_equity.sql
-- Phase 9b — adds 3400 Opening Balance Equity to the default chart and
-- backfills every existing organization. THE DEFAULT CHART BECOMES 45
-- ACCOUNTS. Modelled on 003; 003 itself is applied and checksummed and is
-- NOT edited (rule 13) — a chart change is always a new migration.
--
-- 3400 is where an imported trial balance's imbalance is plugged. It exists
-- so that 3200 Retained Earnings can stay derived: reportService.balanceSheet
-- computes retained earnings from revenue minus expense, and anything posted
-- to 3200 would be counted twice.
--
-- The EXISTS guard matters: an organization with no chart at all must not
-- receive a lone orphan 3400. On a fresh database this correctly inserts
-- nothing, since authService.register already seeds 3400 as part of
-- DEFAULT_CHART from this migration forward.

INSERT INTO accounts (org_id, code, name, type, is_postable, parent_id)
SELECT o.id, '3400', 'Opening Balance Equity', 'Equity', true,
       (SELECT p.id FROM accounts p WHERE p.org_id = o.id AND p.code = '3000')
  FROM organizations o
 WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND a.code = '3000')
ON CONFLICT (org_id, code) DO NOTHING;
