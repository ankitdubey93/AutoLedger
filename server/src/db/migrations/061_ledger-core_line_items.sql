-- 061_ledger-core_line_items.sql
-- Phase 20 — links invoice_lines and bill_lines to the item catalogue
-- (migration 059). Picking an item COPIES its defaults into the line at
-- write time; the line never reads through to the item afterward, so
-- item_id is a record of what was picked, not a live reference the line's
-- values depend on. Nullable on purpose: every existing line has no item,
-- and a free-typed line must stay legal forever.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere
-- below leaves the database untouched.

ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS item_id UUID;
ALTER TABLE bill_lines    ADD COLUMN IF NOT EXISTS item_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoice_lines_item') THEN
    ALTER TABLE invoice_lines ADD CONSTRAINT fk_invoice_lines_item
      FOREIGN KEY (org_id, item_id) REFERENCES items (org_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bill_lines_item') THEN
    ALTER TABLE bill_lines ADD CONSTRAINT fk_bill_lines_item
      FOREIGN KEY (org_id, item_id) REFERENCES items (org_id, id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_invoice_lines_item ON invoice_lines (item_id);
CREATE INDEX IF NOT EXISTS idx_bill_lines_item    ON bill_lines (item_id);
