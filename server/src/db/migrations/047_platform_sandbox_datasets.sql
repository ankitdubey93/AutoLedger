-- 047_platform_sandbox_datasets.sql
-- Phase 18 — the sandbox dataset. See docs/roadmap.md#phase-18-as-delivered.
--
-- One row per organization recording that the demo dataset was loaded, which
-- version of it, and the month every relative fixture offset was resolved
-- against. It is a marker, not a copy of the data: the seeded invoices, bills
-- and payments are ordinary LedgerCore rows, indistinguishable from hand-entered
-- ones, because they were created through the same services and fired the same
-- triggers. That is the whole point of the dataset.
--
-- UNIQUE (org_id) is the one-dataset-per-org rule, enforced by the database
-- rather than by a service-level check. A double load would silently double
-- every balance, and a check-then-insert in the service is a race; the unique
-- index makes the second load impossible instead of merely unlikely. The
-- service maps 23505 on this constraint to a 409.
--
-- anchor_month is stored because a fixture's dates are relative (monthOffset
-- -23..0) and are resolved at load time. Without the anchor, nothing can later
-- say which real month a seeded row was meant to represent.
--
-- counts is UNTRUSTED-shaped only in the sense that it is free-form JSONB: it is
-- written by the orchestrator from its own return values, never from a request
-- body, and is bound as a single JSONB parameter. It is display data for the
-- "sample data is loaded" card, not something any query branches on.

CREATE TABLE IF NOT EXISTS sandbox_datasets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  dataset_version TEXT NOT NULL CHECK (length(btrim(dataset_version)) > 0
                                       AND length(dataset_version) <= 40),

  -- Always the first of a month, matching the fixture offset convention.
  anchor_month    DATE NOT NULL,

  counts          JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- RESTRICT, not CASCADE: this is an audit reference to who loaded it, and a
  -- user row must not be removable while that record stands. Same call
  -- fiscal_periods.closed_by and taxguard_corpus_documents.created_by make.
  loaded_by       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  loaded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_sandbox_datasets_org UNIQUE (org_id),
  CONSTRAINT chk_sandbox_counts_object CHECK (jsonb_typeof(counts) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_sandbox_datasets_org ON sandbox_datasets (org_id);

CREATE OR REPLACE TRIGGER trg_sandbox_datasets_updated_at
  BEFORE UPDATE ON sandbox_datasets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_sandbox_datasets_audit
  AFTER INSERT OR UPDATE OR DELETE ON sandbox_datasets
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('platform');
