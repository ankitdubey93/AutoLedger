-- 031_ap-flow_documents.sql
-- Phase 10 — AP-Flow: capture & extraction. See docs/ap-flow.md and
-- docs/roadmap.md#phase-10.
--
-- Three tables. ap_flow_documents is the registration of a Document Vault
-- row (migration 030) as something AP-Flow is going to process — it carries
-- no bytes itself, only a pointer plus a status. ap_flow_pages and
-- ap_flow_extractions are the pipeline's output: rasterized/redacted page
-- metadata and the structured extraction, both replaced wholesale on every
-- re-extraction rather than edited (see the immutability trigger below).

CREATE TABLE IF NOT EXISTS ap_flow_documents (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id           UUID NOT NULL,
  status                TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','PROCESSING','EXTRACTED','FAILED')),
  page_count            INT NULL CHECK (page_count IS NULL OR page_count > 0),
  failure_reason        TEXT NULL CHECK (failure_reason IS NULL OR length(failure_reason) <= 1000),
  processing_started_at TIMESTAMPTZ NULL,
  processed_at          TIMESTAMPTZ NULL,
  created_by            UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Composite FK to the platform documents row (migration 030), so a
  -- cross-tenant registration is unrepresentable, not just service-checked.
  CONSTRAINT fk_ap_flow_documents_document
    FOREIGN KEY (org_id, document_id) REFERENCES documents (org_id, id) ON DELETE CASCADE,
  CONSTRAINT ux_ap_flow_documents_document UNIQUE (org_id, document_id),
  CONSTRAINT ux_ap_flow_documents_org_id_id UNIQUE (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_ap_flow_documents_org_status
  ON ap_flow_documents (org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ap_flow_documents_created_by
  ON ap_flow_documents (created_by);

CREATE TABLE IF NOT EXISTS ap_flow_pages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ap_flow_document_id UUID NOT NULL,
  page_number         INT NOT NULL CHECK (page_number >= 1),
  width_px            INT NOT NULL CHECK (width_px > 0),
  height_px           INT NOT NULL CHECK (height_px > 0),
  redacted_sha256     CHAR(64) NOT NULL CHECK (redacted_sha256 ~ '^[0-9a-f]{64}$'),
  ocr_text            TEXT NOT NULL,
  redacted_regions    JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fk_ap_flow_pages_document
    FOREIGN KEY (org_id, ap_flow_document_id)
    REFERENCES ap_flow_documents (org_id, id) ON DELETE CASCADE,
  CONSTRAINT ux_ap_flow_pages_number UNIQUE (org_id, ap_flow_document_id, page_number)
);

CREATE INDEX IF NOT EXISTS idx_ap_flow_pages_document
  ON ap_flow_pages (org_id, ap_flow_document_id, page_number);

CREATE TABLE IF NOT EXISTS ap_flow_extractions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ap_flow_document_id UUID NOT NULL,
  vendor_name         TEXT NULL CHECK (vendor_name IS NULL OR length(vendor_name) <= 200),
  invoice_number      TEXT NULL CHECK (invoice_number IS NULL OR length(invoice_number) <= 100),
  invoice_date        DATE NULL,
  currency            CHAR(3) NULL CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  subtotal_cents      BIGINT NULL CHECK (subtotal_cents IS NULL OR subtotal_cents >= 0),
  tax_cents           BIGINT NULL CHECK (tax_cents IS NULL OR tax_cents >= 0),
  total_cents         BIGINT NULL CHECK (total_cents IS NULL OR total_cents >= 0),
  line_items          JSONB NOT NULL DEFAULT '[]'::jsonb,
  field_confidence    JSONB NOT NULL DEFAULT '{}'::jsonb,
  arithmetic_ok       BOOLEAN NOT NULL,
  validation_errors   JSONB NOT NULL DEFAULT '[]'::jsonb,
  model               TEXT NOT NULL CHECK (length(btrim(model)) > 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fk_ap_flow_extractions_document
    FOREIGN KEY (org_id, ap_flow_document_id)
    REFERENCES ap_flow_documents (org_id, id) ON DELETE CASCADE,
  CONSTRAINT ux_ap_flow_extractions_document UNIQUE (org_id, ap_flow_document_id)
);

CREATE OR REPLACE TRIGGER trg_ap_flow_documents_updated
  BEFORE UPDATE ON ap_flow_documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ap_flow_pages and ap_flow_extractions are never edited in place: a
-- re-extraction DELETEs and re-INSERTs, so what the model said on a given
-- run stays non-repudiable. DELETE stays legal; UPDATE does not.
CREATE OR REPLACE FUNCTION reject_ap_flow_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'AP-Flow extraction output is immutable (table %)', TG_TABLE_NAME
    USING ERRCODE = '0A000';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_ap_flow_pages_no_update
  BEFORE UPDATE ON ap_flow_pages
  FOR EACH ROW EXECUTE FUNCTION reject_ap_flow_mutation();

CREATE OR REPLACE TRIGGER trg_ap_flow_extractions_no_update
  BEFORE UPDATE ON ap_flow_extractions
  FOR EACH ROW EXECUTE FUNCTION reject_ap_flow_mutation();

CREATE OR REPLACE TRIGGER trg_ap_flow_documents_audit
  AFTER INSERT OR UPDATE OR DELETE ON ap_flow_documents
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ap-flow');

-- ap_flow_pages is deliberately NOT audited — it is derived raster/OCR
-- output, regenerated wholesale on every re-extraction, the same ruling
-- bank_match_suggestions got in migration 019.
CREATE OR REPLACE TRIGGER trg_ap_flow_extractions_audit
  AFTER INSERT OR UPDATE OR DELETE ON ap_flow_extractions
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ap-flow');
