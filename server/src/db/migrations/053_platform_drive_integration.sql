-- 053_platform_drive_integration.sql
-- Phase 19.3 — Drive folder intake promoted from AP-Flow to a platform
-- integration. See docs/roadmap.md#phase-193-as-delivered.
--
-- Three things happen here:
--
-- 1. 052's two tables are RENAMED out of the ap_flow_* namespace. The
--    integration is no longer AP-Flow's: a folder's `purpose` now routes its
--    files to the app that owns that purpose — VENDOR_BILL to AP-Flow's
--    captureFile, BANK_STATEMENT to LedgerCore's importStatement — through
--    that app's own service function, never its tables (guardrails rule 16).
--    A table named after one app while serving two is drift by construction.
--
-- 2. A second authentication mode. A Google service account needs no consent
--    screen, no Google app verification, and — decisively — is not subject to
--    the 7-day refresh-token expiry Google imposes on an external OAuth app in
--    "Testing" publishing status. The tenant shares a folder with the service
--    account's address instead of walking a consent flow. OAuth is retained,
--    so `auth_mode` discriminates and the CHECK below makes the two payload
--    shapes mutually exclusive at the schema level.
--
-- 3. The folder moves off the connection into its own table. 052 inlined a
--    single folder on the connection under UNIQUE (org_id); an org now
--    registers many folders, each with its own purpose, cursor and sync state.
--
-- DESTRUCTIVE STATEMENTS, SIGNED OFF 2026-09-17 (guardrails rule 13): two
-- ALTER TABLE ... RENAME, and DROP CONSTRAINT on
-- chk_ap_flow_drive_connections_connected_token. 19.2 shipped on 2026-09-17
-- with no production users, so the data at risk is development data only.
-- Rename was chosen over create-new-and-copy because the alternative leaves
-- two dead tables on disk that docs/schema.md, factories.resetTables() and
-- every future reader must keep accounting for, and would force rebuilding
-- both the composite FK and the once-per-org file history anyway.
--
-- NEITHER RENAMED TABLE IS AUDITED, still. 052's reasoning is unchanged:
-- `audit_row_change` snapshots `to_jsonb(NEW)`, which would copy
-- `refresh_token_ciphertext` into an append-only audit_logs row forever. An
-- encrypted secret is still a secret, and CDC must never be the second place
-- it leaks to.

-- ---------------------------------------------------------------- 1. rename
--
-- PostgreSQL does NOT rename a table's constraints, indexes or triggers when
-- the table is renamed — they keep their old names silently, and
-- docs/schema.md starts lying the moment that is overlooked. Every one is
-- renamed below.
--
-- The constraint and index renames are driven by a catalog loop rather than a
-- hand-written list. Several of 052's constraints are named by PostgreSQL, not
-- by us (`ap_flow_drive_connections_pkey`, `..._org_id_fkey`, and one
-- `..._<column>_check` per inline column CHECK). Hand-listing auto-generated
-- names means guessing them, and a single wrong guess fails the whole
-- migration; matching the old prefix in the catalog cannot guess wrong.
--
-- `ALTER TABLE ... RENAME` has no IF EXISTS on the target, so each rename is
-- guarded on the catalog. The runner gives every file its own transaction with
-- transactional DDL (src/db/migrate.ts), so a failure here rolls the whole file
-- back — but the guards also make a re-run against a partially-renamed
-- database a no-op, which is what rule 13's idempotency actually asks for.

DO $$
DECLARE
  target RECORD;
BEGIN
  IF to_regclass('public.ap_flow_drive_connections') IS NOT NULL
     AND to_regclass('public.integration_drive_connections') IS NULL THEN
    ALTER TABLE ap_flow_drive_connections RENAME TO integration_drive_connections;
  END IF;

  IF to_regclass('public.ap_flow_drive_files') IS NOT NULL
     AND to_regclass('public.integration_drive_files') IS NULL THEN
    ALTER TABLE ap_flow_drive_files RENAME TO integration_drive_files;
  END IF;

  -- Constraints: ux_ap_flow_drive_connections_org, fk_ap_flow_drive_files_*,
  -- chk_ap_flow_drive_files_outcome, plus every PostgreSQL-generated
  -- *_pkey / *_fkey / *_check on the two tables.
  FOR target IN
    SELECT con.conname, cls.relname
      FROM pg_constraint con
      JOIN pg_class cls ON cls.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
     WHERE nsp.nspname = 'public'
       AND cls.relname IN ('integration_drive_connections', 'integration_drive_files')
       AND con.conname LIKE '%ap!_flow!_drive!_%' ESCAPE '!'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
      target.relname,
      target.conname,
      replace(target.conname, 'ap_flow_drive_', 'integration_drive_')
    );
  END LOOP;

  -- Standalone indexes only. An index backing a UNIQUE or PRIMARY KEY
  -- constraint was already renamed with its constraint above; renaming it
  -- again here would fail.
  FOR target IN
    SELECT idx.relname AS conname
      FROM pg_class idx
      JOIN pg_index ix ON ix.indexrelid = idx.oid
      JOIN pg_class tbl ON tbl.oid = ix.indrelid
      JOIN pg_namespace nsp ON nsp.oid = idx.relnamespace
     WHERE nsp.nspname = 'public'
       AND tbl.relname IN ('integration_drive_connections', 'integration_drive_files')
       AND idx.relname LIKE '%ap!_flow!_drive!_%' ESCAPE '!'
       AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = idx.oid)
  LOOP
    EXECUTE format(
      'ALTER INDEX %I RENAME TO %I',
      target.conname,
      replace(target.conname, 'ap_flow_drive_', 'integration_drive_')
    );
  END LOOP;

  IF to_regclass('public.integration_drive_connections') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_ap_flow_drive_connections_updated'
          AND tgrelid = 'public.integration_drive_connections'::regclass
     ) THEN
    ALTER TRIGGER trg_ap_flow_drive_connections_updated
      ON integration_drive_connections
      RENAME TO trg_integration_drive_connections_updated;
  END IF;
END $$;

-- ------------------------------------------------------------ 2. auth mode
--
-- Existing rows are all OAuth connections, so DEFAULT 'OAUTH' backfills them
-- correctly and the column can be NOT NULL from the start.

ALTER TABLE integration_drive_connections
  ADD COLUMN IF NOT EXISTS auth_mode TEXT NOT NULL DEFAULT 'OAUTH';

ALTER TABLE integration_drive_connections
  DROP CONSTRAINT IF EXISTS chk_integration_drive_connections_auth_mode;
ALTER TABLE integration_drive_connections
  ADD CONSTRAINT chk_integration_drive_connections_auth_mode
  CHECK (auth_mode IN ('OAUTH', 'SERVICE_ACCOUNT'));

-- 052's CHECK read "CONNECTED implies a refresh token". A SERVICE_ACCOUNT
-- connection is CONNECTED and has no refresh token — and must never acquire
-- one, nor any OAuth-handshake state, because there is no handshake. The
-- replacement states both shapes as one mutually exclusive rule, so a row can
-- never carry a half-populated mixture of the two modes.
ALTER TABLE integration_drive_connections
  DROP CONSTRAINT IF EXISTS chk_ap_flow_drive_connections_connected_token;
ALTER TABLE integration_drive_connections
  DROP CONSTRAINT IF EXISTS chk_integration_drive_connections_connected_token;
ALTER TABLE integration_drive_connections
  DROP CONSTRAINT IF EXISTS chk_integration_drive_connections_auth_payload;
ALTER TABLE integration_drive_connections
  ADD CONSTRAINT chk_integration_drive_connections_auth_payload CHECK (
    (auth_mode = 'OAUTH'
       AND (status <> 'CONNECTED' OR refresh_token_ciphertext IS NOT NULL))
    OR
    (auth_mode = 'SERVICE_ACCOUNT'
       AND refresh_token_ciphertext IS NULL
       AND oauth_state_sha256 IS NULL
       AND pkce_verifier_ciphertext IS NULL)
  );

-- `folder_id` and `folder_name` on the connection are left in place, unused,
-- superseded by integration_drive_folders below. Dropping them is a second
-- destructive change that buys nothing; they are documented as vestigial in
-- docs/schema.md.

-- -------------------------------------------------------------- 3. folders

CREATE TABLE IF NOT EXISTS integration_drive_folders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id     UUID NOT NULL,
  purpose           TEXT NOT NULL CHECK (purpose IN ('VENDOR_BILL', 'BANK_STATEMENT')),
  folder_id         TEXT NOT NULL CHECK (folder_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  folder_name       TEXT NOT NULL CHECK (length(folder_name) <= 255),
  is_active         BOOLEAN NOT NULL DEFAULT true,

  -- BANK_STATEMENT payload. `ledger_account_id` carries NO REFERENCES: rules 8
  -- and 16 collide here and 16 wins, the identical ruling
  -- `document_links.entity_id`, `journal_entries.source_id` and
  -- `ai_model_calls.entity_id` already carry. A platform table must not
  -- hard-wire a foreign key into one app's schema. driveFolderService validates
  -- the id through LedgerCore's OWN service (accountService.getAccountById) —
  -- the seam, not the table.
  ledger_account_id UUID NULL,
  date_format       TEXT NULL CHECK (date_format IS NULL OR date_format IN ('ISO', 'DMY', 'MDY')),
  column_map        JSONB NULL,

  -- High-water mark for incremental listing: the RFC-3339 modifiedTime floor
  -- the next files.list sends. NULL means "never synced, list everything".
  drive_cursor      TIMESTAMPTZ NULL,
  last_synced_at    TIMESTAMPTZ NULL,
  last_sync_error   TEXT NULL CHECK (last_sync_error IS NULL OR length(last_sync_error) <= 1000),

  created_by        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Composite FK: a folder can only ever point at a connection in its own
  -- organization, enforced by the database rather than by a service-level
  -- check (study/postgresql/composite-foreign-keys-for-tenancy.md).
  CONSTRAINT fk_integration_drive_folders_connection
    FOREIGN KEY (org_id, connection_id)
    REFERENCES integration_drive_connections (org_id, id) ON DELETE CASCADE,

  -- The composite-FK target for integration_drive_files below.
  CONSTRAINT ux_integration_drive_folders_org_id_id UNIQUE (org_id, id),

  -- One org may watch the same Drive folder for two different purposes, but
  -- never twice for the same one.
  CONSTRAINT ux_integration_drive_folders_folder UNIQUE (org_id, folder_id, purpose),

  -- A discriminated union, the chk_forecaster_lines_kind_payload pattern: the
  -- columns the purpose names are NOT NULL and every other one is NULL, so a
  -- VENDOR_BILL folder can never carry bank settings that nothing would read.
  -- `column_map` stays optional for BANK_STATEMENT — importStatement resolves
  -- columns by header when none is supplied.
  CONSTRAINT chk_integration_drive_folders_purpose_payload CHECK (
    (purpose = 'VENDOR_BILL'
       AND ledger_account_id IS NULL AND date_format IS NULL AND column_map IS NULL)
    OR
    (purpose = 'BANK_STATEMENT'
       AND ledger_account_id IS NOT NULL AND date_format IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_integration_drive_folders_connection
  ON integration_drive_folders (org_id, connection_id);

-- Serves driveSyncService.listFoldersDueForSync's `last_synced_at` predicate.
CREATE INDEX IF NOT EXISTS idx_integration_drive_folders_due
  ON integration_drive_folders (last_synced_at) WHERE is_active;

CREATE OR REPLACE TRIGGER trg_integration_drive_folders_updated
  BEFORE UPDATE ON integration_drive_folders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------- 4. files: destination
--
-- 052 recorded the import destination as `ap_flow_document_id` with a real FK
-- into ap_flow_documents. With two destination apps that is no longer legal:
-- a platform table would need one nullable FK column per app, forever, each
-- hard-wired into an app's schema. `(result_app, result_entity_id)` is the
-- source_type/source_id convention guardrails rule 16 already names.
--
-- THE COST, STATED: this trades away 052's PG15+ column-list
-- `ON DELETE SET NULL (ap_flow_document_id)`, so deleting an AP-Flow document
-- now leaves a dangling result_entity_id. Acceptable here and nowhere else —
-- this is an append-only ingestion log, and the id is a breadcrumb for an
-- operator reading sync history, never a join key. `ap_flow_document_id` and
-- its FK are kept, vestigial, so nothing already recorded is lost.

ALTER TABLE integration_drive_files
  ADD COLUMN IF NOT EXISTS folder_id        UUID NULL,
  ADD COLUMN IF NOT EXISTS result_app       TEXT NULL,
  ADD COLUMN IF NOT EXISTS result_entity_id UUID NULL;

ALTER TABLE integration_drive_files
  DROP CONSTRAINT IF EXISTS fk_integration_drive_files_folder;
ALTER TABLE integration_drive_files
  ADD CONSTRAINT fk_integration_drive_files_folder
  FOREIGN KEY (org_id, folder_id)
  REFERENCES integration_drive_folders (org_id, id) ON DELETE CASCADE;

ALTER TABLE integration_drive_files
  DROP CONSTRAINT IF EXISTS chk_integration_drive_files_result_app;
ALTER TABLE integration_drive_files
  ADD CONSTRAINT chk_integration_drive_files_result_app
  CHECK (result_app IS NULL OR result_app IN ('ap-flow', 'ledger-core'));

ALTER TABLE integration_drive_files
  DROP CONSTRAINT IF EXISTS chk_integration_drive_files_result;
ALTER TABLE integration_drive_files
  ADD CONSTRAINT chk_integration_drive_files_result
  CHECK ((result_app IS NULL) = (result_entity_id IS NULL));

CREATE INDEX IF NOT EXISTS idx_integration_drive_files_folder
  ON integration_drive_files (org_id, folder_id);

-- -------------------------------------------------------------- 5. backfill
--
-- 052's single inlined folder becomes one VENDOR_BILL folder row per connected
-- org — that was the only purpose 19.2 could serve. Both statements are
-- guarded so a re-run inserts and updates nothing.

INSERT INTO integration_drive_folders
  (org_id, connection_id, purpose, folder_id, folder_name, created_by)
SELECT c.org_id,
       c.id,
       'VENDOR_BILL',
       c.folder_id,
       COALESCE(c.folder_name, 'Imported folder'),
       c.connected_by
  FROM integration_drive_connections c
 WHERE c.folder_id IS NOT NULL
ON CONFLICT (org_id, folder_id, purpose) DO NOTHING;

UPDATE integration_drive_files f
   SET folder_id        = fo.id,
       result_app       = CASE WHEN f.ap_flow_document_id IS NOT NULL THEN 'ap-flow' END,
       result_entity_id = f.ap_flow_document_id
  FROM integration_drive_folders fo
 WHERE fo.org_id = f.org_id
   AND fo.connection_id = f.connection_id
   AND fo.purpose = 'VENDOR_BILL'
   AND f.folder_id IS NULL;
