-- 052_ap-flow_drive_intake.sql
-- Phase 19.2 — AP-Flow: Google Drive folder intake. See
-- docs/roadmap.md#phase-192-as-delivered.
--
-- Two tables. ap_flow_drive_connections is one per-org OAuth 2.0 +
-- PKCE-authenticated Drive connection (UNIQUE (org_id) — one connection per
-- tenant). ap_flow_drive_files is the ingestion log: one row per Drive file
-- ID ever seen, so a synced file is imported at most once even across a
-- reconnect.
--
-- NEITHER TABLE IS AUDITED. `audit_row_change` snapshots `to_jsonb(NEW)`,
-- which would copy `refresh_token_ciphertext` into an append-only
-- audit_logs row forever — an encrypted secret is still a secret, and CDC
-- must never be the second place it leaks to. ap_flow_drive_files is also
-- an ingestion log whose outcome is already audited through
-- ap_flow_documents; imported documents themselves are audited as normal.
--
-- ux_ap_flow_drive_files_file makes one Drive file importable once per org
-- even after a folder change or reconnect — disconnect deletes the history
-- (cascade via ap_flow_drive_connections), and re-import after reconnect is
-- safe because captureFile is idempotent on content hash.

CREATE TABLE IF NOT EXISTS ap_flow_drive_connections (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status                    TEXT NOT NULL CHECK (status IN ('PENDING_AUTH','CONNECTED','NEEDS_REAUTH')),
  google_account_email      TEXT NULL CHECK (google_account_email IS NULL OR length(google_account_email) <= 320),
  refresh_token_ciphertext  TEXT NULL,
  oauth_state_sha256        CHAR(64) NULL CHECK (oauth_state_sha256 IS NULL OR oauth_state_sha256 ~ '^[0-9a-f]{64}$'),
  pkce_verifier_ciphertext  TEXT NULL,
  oauth_state_expires_at    TIMESTAMPTZ NULL,
  folder_id                 TEXT NULL CHECK (folder_id IS NULL OR folder_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  folder_name               TEXT NULL CHECK (folder_name IS NULL OR length(folder_name) <= 255),
  last_synced_at            TIMESTAMPTZ NULL,
  last_sync_error           TEXT NULL CHECK (last_sync_error IS NULL OR length(last_sync_error) <= 1000),
  connected_by              UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_ap_flow_drive_connections_org UNIQUE (org_id),
  CONSTRAINT ux_ap_flow_drive_connections_org_id_id UNIQUE (org_id, id),
  CONSTRAINT chk_ap_flow_drive_connections_connected_token
    CHECK (status <> 'CONNECTED' OR refresh_token_ciphertext IS NOT NULL),
  CONSTRAINT chk_ap_flow_drive_connections_state_complete
    CHECK ((oauth_state_sha256 IS NULL) = (oauth_state_expires_at IS NULL)
       AND (oauth_state_sha256 IS NULL) = (pkce_verifier_ciphertext IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ap_flow_drive_connections_state
  ON ap_flow_drive_connections (oauth_state_sha256) WHERE oauth_state_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ap_flow_drive_connections_connected_by
  ON ap_flow_drive_connections (connected_by);
CREATE INDEX IF NOT EXISTS idx_ap_flow_drive_connections_due
  ON ap_flow_drive_connections (status) WHERE status = 'CONNECTED' AND folder_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ap_flow_drive_files (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id        UUID NOT NULL,
  drive_file_id        TEXT NOT NULL CHECK (drive_file_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  name                 TEXT NOT NULL CHECK (length(name) <= 255),
  mime_type            TEXT NOT NULL CHECK (length(mime_type) <= 100),
  md5_checksum         TEXT NULL CHECK (md5_checksum IS NULL OR md5_checksum ~ '^[0-9a-f]{32}$'),
  drive_modified_at    TIMESTAMPTZ NULL,
  status               TEXT NOT NULL CHECK (status IN ('IMPORTED','SKIPPED')),
  skip_reason          TEXT NULL CHECK (skip_reason IS NULL OR length(skip_reason) <= 1000),
  ap_flow_document_id  UUID NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_ap_flow_drive_files_connection
    FOREIGN KEY (org_id, connection_id) REFERENCES ap_flow_drive_connections (org_id, id) ON DELETE CASCADE,
  -- PG15+ column-list form: nulls only ap_flow_document_id, never org_id
  -- (the composite ON DELETE SET NULL trap — see
  -- study/postgresql/composite-foreign-keys-for-tenancy.md).
  CONSTRAINT fk_ap_flow_drive_files_document
    FOREIGN KEY (org_id, ap_flow_document_id) REFERENCES ap_flow_documents (org_id, id)
    ON DELETE SET NULL (ap_flow_document_id),
  CONSTRAINT ux_ap_flow_drive_files_file UNIQUE (org_id, drive_file_id),
  CONSTRAINT chk_ap_flow_drive_files_outcome CHECK (
    (status = 'IMPORTED' AND skip_reason IS NULL) OR (status = 'SKIPPED' AND skip_reason IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_ap_flow_drive_files_connection ON ap_flow_drive_files (org_id, connection_id);
CREATE INDEX IF NOT EXISTS idx_ap_flow_drive_files_document ON ap_flow_drive_files (org_id, ap_flow_document_id);

CREATE OR REPLACE TRIGGER trg_ap_flow_drive_connections_updated
  BEFORE UPDATE ON ap_flow_drive_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
