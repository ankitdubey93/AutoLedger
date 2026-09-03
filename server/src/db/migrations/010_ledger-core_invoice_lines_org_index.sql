-- 010_ledger-core_invoice_lines_org_index.sql
-- Phase 3.8 follow-up — guardrail-review finding: invoice_lines had no index
-- leading with org_id, unlike ledger_lines' idx_ledger_lines_org_account
-- (004). No current query scans invoice_lines by org_id alone without an
-- invoice_id, so this was not a leak, but every scope column should be
-- indexed on principle (guardrails rule 8) and consistently with the
-- established convention.

CREATE INDEX IF NOT EXISTS idx_invoice_lines_org_invoice ON invoice_lines (org_id, invoice_id);
