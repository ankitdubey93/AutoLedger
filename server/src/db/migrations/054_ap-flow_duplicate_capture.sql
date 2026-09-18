-- 054_ap-flow_duplicate_capture.sql
-- AP-Flow: surface a content-duplicate capture instead of silently merging
-- it into the existing document. See docs/roadmap.md#phase-194-as-delivered.
--
-- The bug this fixes: `ux_ap_flow_documents_document UNIQUE (org_id,
-- document_id)` made it physically impossible for a second
-- ap_flow_documents row to point at the same vault document (the Document
-- Vault is content-addressed by SHA-256 — re-uploading identical bytes,
-- even under a different filename or via a different Drive file, resolves
-- to the same vault row). `captureFile` therefore silently returned the
-- ORIGINAL registration on a repeat capture, with no new row and no signal
-- to the uploader that anything happened — the exact behaviour reported
-- against Google Drive intake (Phase 19.3), which shares this function
-- with direct upload.
--
-- DESTRUCTIVE STATEMENT, SIGNED OFF 2026-09-18: DROP CONSTRAINT on
-- ux_ap_flow_documents_document. The constraint's original purpose — refuse
-- a second registration of the same bytes — is superseded by a strictly
-- better one: allow it, but land it as a visibly flagged DUPLICATE row a
-- human decides on, rather than merging it invisibly into the original.

ALTER TABLE ap_flow_documents
  DROP CONSTRAINT IF EXISTS ux_ap_flow_documents_document;

-- `duplicate_of_id` is a genuine composite FK, not a rule-16 case — both
-- sides are this same app's own table. The PG15+ column-list ON DELETE SET
-- NULL form nulls only this column, never org_id, if the row it points at
-- is ever deleted (see study/postgresql/composite-foreign-keys-for-tenancy.md).
ALTER TABLE ap_flow_documents
  ADD COLUMN IF NOT EXISTS duplicate_of_id UUID NULL;

ALTER TABLE ap_flow_documents
  DROP CONSTRAINT IF EXISTS fk_ap_flow_documents_duplicate_of;
ALTER TABLE ap_flow_documents
  ADD CONSTRAINT fk_ap_flow_documents_duplicate_of
  FOREIGN KEY (org_id, duplicate_of_id)
  REFERENCES ap_flow_documents (org_id, id) ON DELETE SET NULL (duplicate_of_id);

ALTER TABLE ap_flow_documents
  DROP CONSTRAINT IF EXISTS chk_ap_flow_documents_duplicate_payload;
ALTER TABLE ap_flow_documents
  ADD CONSTRAINT chk_ap_flow_documents_duplicate_payload
  CHECK ((status = 'DUPLICATE') = (duplicate_of_id IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_ap_flow_documents_duplicate_of
  ON ap_flow_documents (org_id, duplicate_of_id) WHERE duplicate_of_id IS NOT NULL;

-- Extend the status enum. DUPLICATE is a second legal birth state alongside
-- PENDING (set once, at INSERT, by captureFile — never assigned by an
-- UPDATE) and transitions to PENDING exactly like FAILED does: pushing a
-- duplicate through re-runs the ordinary pipeline via the existing
-- requestReextraction path, no new endpoint.
ALTER TABLE ap_flow_documents
  DROP CONSTRAINT IF EXISTS ap_flow_documents_status_check;
ALTER TABLE ap_flow_documents
  ADD CONSTRAINT ap_flow_documents_status_check
  CHECK (status IN ('PENDING','PROCESSING','EXTRACTED','FAILED','POSTED','DUPLICATE'));
