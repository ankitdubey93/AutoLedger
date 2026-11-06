-- Phase 49e — tax invoices. A tax invoice is a statement made on the day it was
-- issued, so the seller's identity is kept with it: read live, a later change of
-- ABN or GST registration would rewrite every invoice already sent.
--
-- NULL on a GENERIC organization's documents and on drafts. Written once, in the
-- same statement sequence that issues the document.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS seller_abn TEXT NULL,
  ADD COLUMN IF NOT EXISTS seller_legal_name TEXT NULL,
  ADD COLUMN IF NOT EXISTS seller_gst_registered BOOLEAN NULL;

ALTER TABLE credit_notes
  ADD COLUMN IF NOT EXISTS seller_abn TEXT NULL,
  ADD COLUMN IF NOT EXISTS seller_legal_name TEXT NULL,
  ADD COLUMN IF NOT EXISTS seller_gst_registered BOOLEAN NULL;
