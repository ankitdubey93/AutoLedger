-- Phase 46a — the Rounding system account (Xero's 860 equivalent). Seeded
-- and tagged by systemAccounts.ts; nothing posts to it automatically yet
-- (allocateCents leaves no residue). ON CONFLICT skips an org whose
-- imported chart already uses 6830. accountService.DEFAULT_CHART gains the
-- same row.
INSERT INTO accounts (org_id, code, name, type, is_postable, parent_id)
SELECT o.id, '6830', 'Rounding', 'Expense', true,
       (SELECT p.id FROM accounts p WHERE p.org_id = o.id AND p.code = '6000')
  FROM organizations o
 WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND a.code = '6000')
ON CONFLICT (org_id, code) DO NOTHING;
