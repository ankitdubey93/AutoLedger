-- 087_ledger-core_placeholder_templates.sql
-- Phase 40 — Xero-style placeholders ([Month], [Year+1], [Contact Name]).
--
-- Placeholders are filled when a document is issued, approved or posted, so
-- none ever reaches a posted row. That would also erase them from the text a
-- recurring schedule copies: a journal is posted the moment it is created,
-- and a schedule may be built from an issued invoice or approved bill. Each
-- *_template column keeps the text as typed, before this document's
-- placeholders were filled, so the next occurrence fills them afresh.
--
-- NULL means "the text had no placeholders" (or was edited since); readers
-- use COALESCE(*_template, text). Written once, when filling first changes
-- the text, and reset to NULL by a draft edit. The bounds match the columns
-- they shadow (description 500, vendor_reference 100) and the API's notes
-- limit (1000).
--
-- Additive and metadata-only: nullable, no DEFAULT, no backfill. The void
-- triggers (009, 013) compare whole rows minus the void columns; these never
-- change on void, so the comparison is unaffected. journal_entries stays
-- insert-only — its template is written with the row.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, and each named CHECK in its own
-- pg_constraint-guarded DO block.

ALTER TABLE invoices        ADD COLUMN IF NOT EXISTS notes_template            TEXT;
ALTER TABLE invoice_lines   ADD COLUMN IF NOT EXISTS description_template      TEXT;
ALTER TABLE bills           ADD COLUMN IF NOT EXISTS notes_template            TEXT;
ALTER TABLE bills           ADD COLUMN IF NOT EXISTS vendor_reference_template TEXT;
ALTER TABLE bill_lines      ADD COLUMN IF NOT EXISTS description_template      TEXT;
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS description_template      TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_invoices_notes_template_length') THEN
    ALTER TABLE invoices
      ADD CONSTRAINT ck_invoices_notes_template_length
      CHECK (notes_template IS NULL OR char_length(notes_template) <= 1000);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_invoice_lines_description_template_length') THEN
    ALTER TABLE invoice_lines
      ADD CONSTRAINT ck_invoice_lines_description_template_length
      CHECK (description_template IS NULL OR char_length(description_template) <= 500);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_bills_notes_template_length') THEN
    ALTER TABLE bills
      ADD CONSTRAINT ck_bills_notes_template_length
      CHECK (notes_template IS NULL OR char_length(notes_template) <= 1000);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_bills_vendor_reference_template_length') THEN
    ALTER TABLE bills
      ADD CONSTRAINT ck_bills_vendor_reference_template_length
      CHECK (vendor_reference_template IS NULL OR char_length(vendor_reference_template) <= 100);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_bill_lines_description_template_length') THEN
    ALTER TABLE bill_lines
      ADD CONSTRAINT ck_bill_lines_description_template_length
      CHECK (description_template IS NULL OR char_length(description_template) <= 500);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_journal_entries_description_template_length') THEN
    ALTER TABLE journal_entries
      ADD CONSTRAINT ck_journal_entries_description_template_length
      CHECK (description_template IS NULL OR char_length(description_template) <= 500);
  END IF;
END $$;
