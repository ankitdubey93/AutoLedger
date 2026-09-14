-- 049_ap-flow_bill_posting.sql
-- Phase 19 — AP-Flow automated intake. See docs/roadmap.md#phase-19.
--
-- Phase 11 posted a raw journal entry with no subledger document behind
-- it — the AP control account (2100) moved, but no `bills` row existed, so
-- `agingService.apAging`'s reconciliation check against the ledger went
-- false the moment AP-Flow posted anything, and the payable could never be
-- paid through /payments. Phase 19 reroutes posting through a real
-- LedgerCore bill; these two columns record that link back on the AP-Flow
-- side.
--
-- bill_id carries NO REFERENCES to LedgerCore's bills table — the same
-- rule-16-over-rule-8 ruling migration 032's header comment records for
-- journal_entry_id: an app boundary is a namespace, not a schema-level FK
-- into another app's tables. Validity is enforced at the service layer
-- (postingService.ts calls billService's exported *OnClient functions,
-- which themselves validate every id they touch).
--
-- ADD COLUMN ... with no DEFAULT (bill_id) or a constant DEFAULT (auto_posted)
-- writes no per-row UPDATE and rewrites nothing on a populated table
-- (PostgreSQL 11+ fast default), so trg_ap_flow_documents_posted_guard
-- (migration 032, BEFORE UPDATE) never fires here — a real UPDATE
-- backfilling existing POSTED rows would have been rejected by it. Existing
-- POSTED rows from Phase 11 legitimately keep bill_id NULL and
-- auto_posted false: they posted a raw journal entry, not a bill, and nothing
-- about them was auto-posted.

ALTER TABLE ap_flow_documents ADD COLUMN IF NOT EXISTS bill_id UUID NULL;
ALTER TABLE ap_flow_documents ADD COLUMN IF NOT EXISTS auto_posted BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_ap_flow_documents_bill
  ON ap_flow_documents (org_id, bill_id) WHERE bill_id IS NOT NULL;
