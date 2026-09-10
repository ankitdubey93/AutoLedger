-- 030_platform_documents.sql
-- Phase 9.5 — the Document Vault. See docs/roadmap.md#phase-95-planned-scope.
--
-- Platform tables, not an app's: LedgerCore attaching a PDF to an invoice
-- and AP-Flow attaching a source image are both apps talking to the
-- platform, never to each other. That is what keeps guardrails rule 16
-- intact, and it is why document_links carries app_slug rather than each
-- app owning its own attachment table.
--
-- The bytes live on the filesystem under STORAGE_ROOT/<org_id>/<ab>/<cd>/
-- <sha256> (services/storageService.ts). Only the metadata is here.

CREATE TABLE IF NOT EXISTS documents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Lowercase hex, produced by node:crypto. The CHECK is what lets
  -- storageService.blobPath treat this value as a safe path segment.
  sha256            CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size         BIGINT NOT NULL CHECK (byte_size > 0),
  -- Sniffed from magic bytes, never the client's Content-Type header.
  mime_type         TEXT NOT NULL
                    CHECK (mime_type IN ('application/pdf', 'image/png', 'image/jpeg', 'text/csv')),
  original_filename TEXT NOT NULL
                    CHECK (length(btrim(original_filename)) > 0 AND length(original_filename) <= 255),
  uploaded_by       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Re-uploading identical bytes is idempotent, per tenant. Scoped by
  -- org_id, so one tenant can never learn that another holds the same file.
  CONSTRAINT ux_documents_org_sha    UNIQUE (org_id, sha256),
  -- The composite target document_links references, making a cross-tenant
  -- link unrepresentable rather than merely service-checked.
  CONSTRAINT ux_documents_org_id_id  UNIQUE (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_documents_org_created
  ON documents (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_uploaded_by
  ON documents (uploaded_by);

CREATE TABLE IF NOT EXISTS document_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id UUID NOT NULL,
  -- No REFERENCES and no enumerated CHECK: the slug list lives in
  -- config/apps.ts and is validated by isAppSlug in the service, the same
  -- call migrations 017 and 027 made.
  app_slug    TEXT NOT NULL CHECK (length(btrim(app_slug)) > 0 AND length(app_slug) <= 40),
  entity_type TEXT NOT NULL CHECK (length(btrim(entity_type)) > 0 AND length(entity_type) <= 40),
  -- Deliberately NOT a foreign key. The platform must never reference an
  -- app's tables (rule 16), so a link outliving its entity is tolerated and
  -- documented rather than prevented. See docs/roadmap.md#phase-95.
  entity_id   UUID NOT NULL,
  created_by  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fk_document_links_document
    FOREIGN KEY (org_id, document_id) REFERENCES documents (org_id, id) ON DELETE CASCADE,
  CONSTRAINT ux_document_links_target
    UNIQUE (org_id, document_id, app_slug, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_document_links_entity
  ON document_links (org_id, app_slug, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_document_links_document
  ON document_links (org_id, document_id);
CREATE INDEX IF NOT EXISTS idx_document_links_created_by
  ON document_links (created_by);

-- A document's metadata describes bytes that are already on disk and
-- immutable by content-addressing: editing the row would make it describe a
-- file that no longer matches. DELETE stays legal — the service refuses it
-- while any link exists, and DELETE /documents/:id is a real route.
CREATE OR REPLACE FUNCTION reject_document_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Document metadata is immutable (table %)', TG_TABLE_NAME
    USING ERRCODE = '0A000';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_documents_no_update
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION reject_document_mutation();

CREATE OR REPLACE TRIGGER trg_document_links_no_update
  BEFORE UPDATE ON document_links
  FOR EACH ROW EXECUTE FUNCTION reject_document_mutation();

CREATE OR REPLACE TRIGGER trg_documents_audit
  AFTER INSERT OR UPDATE OR DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('platform');

CREATE OR REPLACE TRIGGER trg_document_links_audit
  AFTER INSERT OR UPDATE OR DELETE ON document_links
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('platform');
