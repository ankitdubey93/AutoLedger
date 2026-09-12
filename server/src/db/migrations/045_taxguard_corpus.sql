-- 045_taxguard_corpus.sql
-- Phase 16 — TaxGuard AI: the tax-act corpus. See docs/roadmap.md#phase-16.
--
-- taxguard_corpus_documents mirrors boarddeck_decks' shape (migration 043):
-- a row is created synchronously, its chunks are not — ingestion runs in the
-- background-jobs worker (Phase 7) and the row's status advances
-- PENDING -> PARSING -> EMBEDDING -> READY|FAILED.
--
-- No REFERENCES on document_id to any app-owned table — there is none here;
-- documents is a PLATFORM table (migration 030's own header says so
-- explicitly), so the FK below is not a rule-16 violation, the same reading
-- ap_flow_documents (031) relies on for its own documents FK.
--
-- No immutability trigger on either table — nothing in this phase ever
-- reaches the general ledger, the identical ruling fpa_models,
-- forecaster_plans, unitecon_product_lines and boarddeck_decks each carry.
--
-- No audit trigger on taxguard_chunks. A single ingest can produce thousands
-- of chunk rows for one user action (one PDF upload); writing one audit_logs
-- row per chunk would dwarf every other table's audit volume for no benefit
-- — the parent taxguard_corpus_documents row's own audit trail (status
-- PENDING -> ... -> READY, chunk_count set) is the record of what happened.
--
-- The HNSW index below is unfiltered by org_id — pgvector has no native
-- per-tenant partial index for ANN search, so retrievalService's query
-- filters org_id as a WHERE predicate and pgvector applies it as a
-- post-filter over the ANN candidate set. Acceptable at this project's
-- portfolio scale; noted here rather than hidden.
--
-- REQUIRES migration 044 (CREATE EXTENSION vector) to have applied.

CREATE TABLE IF NOT EXISTS taxguard_corpus_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id   UUID NOT NULL,
  title         TEXT NOT NULL CHECK (length(btrim(title)) > 0 AND length(title) <= 300),
  jurisdiction  TEXT NOT NULL CHECK (jurisdiction IN ('IN','US','UK','CA','AU','OTHER')),
  act_year      INTEGER CHECK (act_year IS NULL OR (act_year >= 1800 AND act_year <= 2200)),
  status        TEXT NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','PARSING','EMBEDDING','READY','FAILED')),
  chunk_count   INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  error_message TEXT CHECK (error_message IS NULL OR length(error_message) <= 500),
  ingested_at   TIMESTAMPTZ,
  created_by    UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fk_taxguard_corpus_document
    FOREIGN KEY (org_id, document_id) REFERENCES documents (org_id, id) ON DELETE CASCADE,
  CONSTRAINT ux_taxguard_corpus_document UNIQUE (org_id, document_id),
  CONSTRAINT ux_taxguard_corpus_org_id_id UNIQUE (org_id, id),
  CONSTRAINT chk_taxguard_corpus_ready CHECK (
    (status =  'READY' AND ingested_at IS NOT NULL AND chunk_count > 0) OR
    (status <> 'READY' AND ingested_at IS NULL)
  ),
  CONSTRAINT chk_taxguard_corpus_failed CHECK (
    (status =  'FAILED' AND error_message IS NOT NULL) OR
    (status <> 'FAILED' AND error_message IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_taxguard_corpus_org_created
  ON taxguard_corpus_documents (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_taxguard_corpus_org_status
  ON taxguard_corpus_documents (org_id, status);
CREATE INDEX IF NOT EXISTS idx_taxguard_corpus_created_by
  ON taxguard_corpus_documents (created_by);

CREATE TABLE IF NOT EXISTS taxguard_chunks (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  corpus_document_id  UUID NOT NULL,
  ordinal             INTEGER NOT NULL CHECK (ordinal >= 0),
  citation            TEXT NOT NULL CHECK (length(btrim(citation)) > 0 AND length(citation) <= 200),
  heading             TEXT CHECK (heading IS NULL OR length(heading) <= 300),
  content             TEXT NOT NULL CHECK (length(btrim(content)) > 0),
  token_estimate      INTEGER NOT NULL CHECK (token_estimate > 0),
  embedding           vector(1024),
  embedded_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fk_taxguard_chunks_corpus
    FOREIGN KEY (org_id, corpus_document_id)
    REFERENCES taxguard_corpus_documents (org_id, id) ON DELETE CASCADE,
  CONSTRAINT ux_taxguard_chunks_ordinal UNIQUE (org_id, corpus_document_id, ordinal),
  CONSTRAINT ux_taxguard_chunks_org_id_id UNIQUE (org_id, id),
  CONSTRAINT chk_taxguard_chunks_embedded CHECK (
    (embedding IS NULL AND embedded_at IS NULL) OR
    (embedding IS NOT NULL AND embedded_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_taxguard_chunks_org_corpus
  ON taxguard_chunks (org_id, corpus_document_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_taxguard_chunks_hnsw
  ON taxguard_chunks USING hnsw (embedding vector_cosine_ops);

CREATE OR REPLACE TRIGGER trg_taxguard_corpus_updated
  BEFORE UPDATE ON taxguard_corpus_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_taxguard_corpus_audit
  AFTER INSERT OR UPDATE OR DELETE ON taxguard_corpus_documents
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('taxguard');
