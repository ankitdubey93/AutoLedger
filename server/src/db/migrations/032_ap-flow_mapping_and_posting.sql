-- 032_ap-flow_mapping_and_posting.sql
-- Phase 11 — AP-Flow: mapping, review & posting. See docs/ap-flow.md and
-- docs/roadmap.md#phase-11.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.
--
-- Three changes. (1) ap_flow_documents gains a POSTED status — its first
-- terminal state, because this is the first phase where AP-Flow writes to
-- the GL, plus the four columns that record where it posted. (2)
-- ap_flow_line_items materializes what was JSONB on ap_flow_extractions,
-- because a reviewer now overrides an account per line. Unlike its sibling
-- ap_flow_pages/ap_flow_extractions, this table stays mutable — a reviewer
-- changes it — until its parent document is POSTED, at which point a
-- trigger (not the service) freezes it. (3) ap_flow_vendor_account_map
-- remembers which account this organization posted a given vendor to last
-- time, keyed by a normalized vendor-name string AP-Flow computes itself.
--
-- Deliberate ruling, cited wherever it matters below: account_id on both new
-- tables carries NO REFERENCES to LedgerCore's accounts table. Guardrails
-- rule 8 ("every *_id gets a REFERENCES constraint") and rule 16 ("no app
-- reads another app's tables directly... app boundaries are namespaces, not
-- tenancy") collide here, and rule 16 wins — the same ruling journal_entries
-- .source_id and document_links.entity_id already carry, both documented as
-- deliberate. A schema-level FK from an AP-Flow table into LedgerCore's
-- accounts table would hard-wire the app boundary into the database itself.
-- Validity is enforced instead at the service layer, three times over:
-- accountService.getAccountById on override (404 cross-tenant), the same at
-- classification time, and definitively journalService.createEntryOnClient's
-- assertAccountsArePostable inside the posting transaction itself. This is
-- safe because accounts are never actually deleted in this codebase — they
-- are retired via is_active = false (see migration 012's own comment) — so a
-- dangling account_id is not a reachable state.

-- --------------------------------------------------- (1) ap_flow_documents

-- DROP + ADD is replay-safe: migrations.test.ts deletes schema_migrations and
-- re-executes every file against a populated database, and dropping a CHECK
-- that no longer matches before re-adding the widened one costs nothing (no
-- existing row can violate a strictly wider allowed set). This is not a
-- guess: `SELECT conname FROM pg_constraint WHERE conrelid =
-- 'ap_flow_documents'::regclass AND contype = 'c'` was run against the
-- running database before this file was written and returned exactly
-- ap_flow_documents_failure_reason_check, ap_flow_documents_page_count_check,
-- ap_flow_documents_status_check — the unqualified, Postgres-assigned name
-- for a column CHECK declared inline in migration 031.
ALTER TABLE ap_flow_documents DROP CONSTRAINT IF EXISTS ap_flow_documents_status_check;
ALTER TABLE ap_flow_documents ADD CONSTRAINT ap_flow_documents_status_check
  CHECK (status IN ('PENDING','PROCESSING','EXTRACTED','FAILED','POSTED'));

ALTER TABLE ap_flow_documents ADD COLUMN IF NOT EXISTS journal_entry_id UUID NULL;
ALTER TABLE ap_flow_documents ADD COLUMN IF NOT EXISTS posted_sha256    CHAR(64) NULL;
ALTER TABLE ap_flow_documents ADD COLUMN IF NOT EXISTS posted_at        TIMESTAMPTZ NULL;
ALTER TABLE ap_flow_documents ADD COLUMN IF NOT EXISTS posted_by        UUID NULL;

-- ALTER TABLE ADD CONSTRAINT has no IF NOT EXISTS, so each gets its own
-- pg_constraint guard — the same idiom 007/012 use, required so this file
-- can be replayed against a database that already has part of it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ap_flow_documents_posted_sha256') THEN
    ALTER TABLE ap_flow_documents ADD CONSTRAINT chk_ap_flow_documents_posted_sha256
      CHECK (posted_sha256 IS NULL OR posted_sha256 ~ '^[0-9a-f]{64}$');
  END IF;

  -- The FSM's completeness proof at the database level: a row cannot claim
  -- POSTED without every fact that status implies already being present.
  -- This is what makes the trg_ap_flow_documents_posted_guard trigger below
  -- catch a service bug that set status='POSTED' without setting the rest.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ap_flow_documents_posted_complete') THEN
    ALTER TABLE ap_flow_documents ADD CONSTRAINT chk_ap_flow_documents_posted_complete
      CHECK (status <> 'POSTED' OR (
        journal_entry_id IS NOT NULL AND posted_sha256 IS NOT NULL
        AND posted_at IS NOT NULL AND posted_by IS NOT NULL
      ));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ap_flow_documents_posted_by') THEN
    ALTER TABLE ap_flow_documents ADD CONSTRAINT fk_ap_flow_documents_posted_by
      FOREIGN KEY (posted_by) REFERENCES users(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- journal_entry_id gets no FK — see the header comment. posted_by does get
-- one: it references the platform's own users table, not another app's.
CREATE INDEX IF NOT EXISTS idx_ap_flow_documents_posted_by ON ap_flow_documents (posted_by);

-- --------------------------------------------------- (2) ap_flow_line_items

CREATE TABLE IF NOT EXISTS ap_flow_line_items (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ap_flow_document_id   UUID NOT NULL,
  line_index            INT NOT NULL CHECK (line_index >= 0),
  description           TEXT NOT NULL CHECK (length(description) <= 500),
  -- No >= 0 check, unlike invoice/bill lines: a credit-note line legitimately
  -- reads negative off the model, and the posting service is what refuses a
  -- non-positive document total, not a column-level constraint here.
  amount_cents          BIGINT NOT NULL,
  -- No REFERENCES accounts — see the header comment (rule 16 over rule 8).
  account_id            UUID NULL,
  suggested_account_id  UUID NULL,
  mapping_source        TEXT NOT NULL DEFAULT 'NONE'
                        CHECK (mapping_source IN ('HISTORY','CHART','MODEL','MANUAL','NONE')),
  mapping_confidence    NUMERIC(4,3) NULL
                        CHECK (mapping_confidence IS NULL OR (mapping_confidence >= 0 AND mapping_confidence <= 1)),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fk_ap_flow_line_items_document
    FOREIGN KEY (org_id, ap_flow_document_id)
    REFERENCES ap_flow_documents (org_id, id) ON DELETE CASCADE,
  CONSTRAINT ux_ap_flow_line_items_index UNIQUE (org_id, ap_flow_document_id, line_index)
);

CREATE INDEX IF NOT EXISTS idx_ap_flow_line_items_document
  ON ap_flow_line_items (org_id, ap_flow_document_id, line_index);

-- ---------------------------------------------- (3) ap_flow_vendor_account_map

CREATE TABLE IF NOT EXISTS ap_flow_vendor_account_map (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- normalizeForMatching(vendorName) — lowercased, punctuation collapsed —
  -- never vendors.id: AP-Flow does not know LedgerCore's vendor table
  -- exists (rule 16).
  vendor_key    TEXT NOT NULL CHECK (length(btrim(vendor_key)) > 0 AND length(vendor_key) <= 200),
  -- No REFERENCES accounts — see the header comment.
  account_id    UUID NOT NULL,
  hit_count     INT NOT NULL DEFAULT 1 CHECK (hit_count >= 1),
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_ap_flow_vendor_map_key UNIQUE (org_id, vendor_key)
);

-- ------------------------------------------------------------------- triggers

CREATE OR REPLACE TRIGGER trg_ap_flow_line_items_updated
  BEFORE UPDATE ON ap_flow_line_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_ap_flow_vendor_map_updated
  BEFORE UPDATE ON ap_flow_vendor_account_map
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- POSTED is ap_flow_documents' first terminal state (types/ap-flow.ts's
-- AP_FLOW_DOCUMENT_TRANSITIONS gives it an empty outbound edge list). This
-- trigger is the database's half of that terminality — unlike invoices'
-- reject_issued_invoice_mutation(), there is no carve-out transition at all:
-- once POSTED, nothing about the row may change, ever. Correction is a
-- reversing entry in LedgerCore, never an edit here.
CREATE OR REPLACE FUNCTION reject_ap_flow_posted_document_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status <> 'POSTED' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'AP-Flow document % is POSTED and is immutable', OLD.id
    USING ERRCODE = '0A000';
END;
$$ LANGUAGE plpgsql;

-- Same-timing BEFORE UPDATE row triggers fire in name order:
-- trg_ap_flow_documents_posted_guard sorts before trg_ap_flow_documents_
-- updated, so the guard sees NEW.updated_at exactly as the service wrote it
-- — the same discipline migration 009's comment records for invoices.
CREATE OR REPLACE TRIGGER trg_ap_flow_documents_posted_guard
  BEFORE UPDATE ON ap_flow_documents
  FOR EACH ROW EXECUTE FUNCTION reject_ap_flow_posted_document_mutation();

-- A line item may only be inserted, changed, or removed while its parent
-- document has not yet posted. A NULL status means the parent row is
-- already gone — the ON DELETE CASCADE of a deleted ap_flow_documents row —
-- so that case passes through rather than raising, mirroring invoice_lines'
-- reject_non_draft_invoice_line_mutation() exactly.
CREATE OR REPLACE FUNCTION reject_ap_flow_posted_line_item_mutation() RETURNS TRIGGER AS $$
DECLARE
  v_doc_id UUID;
  v_status TEXT;
BEGIN
  v_doc_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.ap_flow_document_id ELSE NEW.ap_flow_document_id END;
  SELECT status INTO v_status FROM ap_flow_documents WHERE id = v_doc_id;

  IF v_status = 'POSTED' THEN
    RAISE EXCEPTION 'AP-Flow document % is POSTED — its line items cannot be changed', v_doc_id
      USING ERRCODE = '0A000';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_ap_flow_line_items_posted_guard
  BEFORE UPDATE OR DELETE ON ap_flow_line_items
  FOR EACH ROW EXECUTE FUNCTION reject_ap_flow_posted_line_item_mutation();

-- Both new tables are audited, unlike ap_flow_pages: a reviewer's account
-- override and a posting's vendor-history write are business state, not
-- derived raster/OCR output regenerated wholesale on re-extraction.
CREATE OR REPLACE TRIGGER trg_ap_flow_line_items_audit
  AFTER INSERT OR UPDATE OR DELETE ON ap_flow_line_items
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ap-flow');

CREATE OR REPLACE TRIGGER trg_ap_flow_vendor_map_audit
  AFTER INSERT OR UPDATE OR DELETE ON ap_flow_vendor_account_map
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ap-flow');
