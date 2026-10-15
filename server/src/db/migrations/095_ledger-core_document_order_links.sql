-- 095_ledger-core_document_order_links.sql
-- Phase 43b — a bill may reference the purchase order it fulfils, an invoice
-- the sales order. Until now the link existed only line by line
-- (bill_lines / invoice_lines .order_line_id, migration 092).
--
-- Composite FKs (org_id, x) -> orders (org_id, id) ON DELETE RESTRICT: an order
-- is never deleted once referenced. MATCH SIMPLE lets a NULL link satisfy it.
--
-- Posted-row immutability (rule 6): trg_bills_immutable and trg_invoices_immutable
-- reject ANY column change on a posted/issued/void row (the only carve-out
-- touches status/voided_at/void_journal_entry_id). The trigger is never
-- disabled, so the backfill below is restricted to rows that are still editable:
-- bills in DRAFT / AWAITING_APPROVAL and invoices in DRAFT. Posted documents
-- keep a NULL header link; their line-level order_line_id remains the record.
--
-- Idempotent; the runner applies the file in one transaction.

ALTER TABLE bills    ADD COLUMN IF NOT EXISTS purchase_order_id UUID;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sales_order_id    UUID;

ALTER TABLE bills DROP CONSTRAINT IF EXISTS fk_bills_purchase_order;
ALTER TABLE bills ADD CONSTRAINT fk_bills_purchase_order
  FOREIGN KEY (org_id, purchase_order_id) REFERENCES orders (org_id, id) ON DELETE RESTRICT;

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS fk_invoices_sales_order;
ALTER TABLE invoices ADD CONSTRAINT fk_invoices_sales_order
  FOREIGN KEY (org_id, sales_order_id) REFERENCES orders (org_id, id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_bills_purchase_order ON bills (purchase_order_id) WHERE purchase_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_sales_order ON invoices (sales_order_id) WHERE sales_order_id IS NOT NULL;

-- Backfill: the single order reachable through the document's lines, editable documents only.
UPDATE bills b SET purchase_order_id = x.order_id
  FROM (
    SELECT bl.bill_id, MIN(ol.order_id::text)::uuid AS order_id
      FROM bill_lines bl
      JOIN order_lines ol ON ol.org_id = bl.org_id AND ol.id = bl.order_line_id
     GROUP BY bl.bill_id
    HAVING COUNT(DISTINCT ol.order_id) = 1
  ) x
 WHERE b.id = x.bill_id
   AND b.purchase_order_id IS NULL
   AND b.status IN ('DRAFT', 'AWAITING_APPROVAL');

UPDATE invoices i SET sales_order_id = x.order_id
  FROM (
    SELECT il.invoice_id, MIN(ol.order_id::text)::uuid AS order_id
      FROM invoice_lines il
      JOIN order_lines ol ON ol.org_id = il.org_id AND ol.id = il.order_line_id
     GROUP BY il.invoice_id
    HAVING COUNT(DISTINCT ol.order_id) = 1
  ) x
 WHERE i.id = x.invoice_id
   AND i.sales_order_id IS NULL
   AND i.status = 'DRAFT';
