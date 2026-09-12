-- 046_taxguard_questions.sql
-- Phase 16 — TaxGuard AI: the question/answer log. See docs/roadmap.md#phase-16.
--
-- A question row is written ONCE, after the answer exists — there is no
-- status FSM and no updated_at, so no set_updated_at trigger.
--
-- retrieved_chunk_ids is a plain UUID[] with NO FK, deliberately: a chunk may
-- be deleted by a re-ingest (a new corpus document row, per migration 045's
-- header) and the historical answer must survive that unchanged — the same
-- "link outliving its entity" ruling document_links.entity_id carries in
-- migration 030.

CREATE TABLE IF NOT EXISTS taxguard_questions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  question_text       TEXT NOT NULL CHECK (length(btrim(question_text)) > 0
                                           AND length(question_text) <= 2000),
  redacted_question   TEXT NOT NULL CHECK (length(btrim(redacted_question)) > 0),
  jurisdiction        TEXT NOT NULL CHECK (jurisdiction IN ('IN','US','UK','CA','AU','OTHER')),
  answer_text         TEXT NOT NULL CHECK (length(btrim(answer_text)) > 0),
  citations           JSONB NOT NULL DEFAULT '[]'::jsonb,
  model               TEXT NOT NULL CHECK (length(btrim(model)) > 0 AND length(model) <= 100),
  retrieved_chunk_ids UUID[] NOT NULL DEFAULT '{}',
  latency_ms          INTEGER NOT NULL CHECK (latency_ms >= 0),
  created_by          UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_taxguard_questions_citations_array CHECK (jsonb_typeof(citations) = 'array'),
  CONSTRAINT ux_taxguard_questions_org_id_id UNIQUE (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_taxguard_questions_org_created
  ON taxguard_questions (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_taxguard_questions_created_by
  ON taxguard_questions (created_by);

CREATE OR REPLACE TRIGGER trg_taxguard_questions_audit
  AFTER INSERT OR UPDATE OR DELETE ON taxguard_questions
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('taxguard');
