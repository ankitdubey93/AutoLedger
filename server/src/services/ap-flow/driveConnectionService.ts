import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { env } from '../../config/env.js';
import {
  AP_FLOW_DRIVE_MAX_FILES_PER_SYNC,
  AP_FLOW_DRIVE_OAUTH_STATE_TTL_MINUTES,
  MAX_UPLOAD_BYTES,
} from '../../config/constants.js';
import { decryptSecret, encryptSecret } from '../../utils/secretBox.js';
import { pkceChallengeS256, randomUrlToken, sha256Hex } from '../../utils/pkce.js';
import {
  buildAuthorizationUrl,
  downloadFile,
  exchangeCode,
  getAccountEmail,
  getFolder,
  GoogleDriveError,
  listFolderFiles,
  parseFolderInput,
  refreshAccessToken,
  revokeToken,
} from './googleDriveClient.js';
import type { FetchLike, GoogleOAuthConfig } from './googleDriveClient.js';
import * as apFlowDocumentService from './apFlowDocumentService.js';
import { enqueue } from '../../queue/queues.js';
import { canTransitionApFlowDriveConnection } from '../../types/ap-flow.js';
import type { ApFlowDriveConnection, ApFlowDriveConnectionStatus } from '../../types/ap-flow.js';

/**
 * Google Drive folder intake (Phase 19.2) — a per-org OAuth 2.0 + PKCE
 * connection, polled every AP_FLOW_DRIVE_POLL_INTERVAL_MS, importing new
 * PDF/PNG/JPEG files once each into AP-Flow's own capture pipeline.
 *
 * Every function takes `orgId` first and every statement carries an
 * `org_id` predicate (guardrails rule 1), with exactly two documented
 * exceptions below: `completeConnect`'s state lookup (the OAuth redirect
 * carries no session — the state IS the credential) and
 * `listConnectionsDueForSync` (the scheduler sweep, ids only, every
 * downstream call re-scopes by that row's own org_id).
 *
 * TOKEN HYGIENE: no log line, error message, or return value in this file
 * ever includes a token, verifier, state, or ciphertext.
 */

export interface DriveServiceDeps {
  fetchImpl?: FetchLike;
  oauth?: GoogleOAuthConfig;
  encryptionKeyHex?: string;
}

function effectiveOAuth(deps?: DriveServiceDeps): GoogleOAuthConfig {
  return (
    deps?.oauth ?? {
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
    }
  );
}

function effectiveKey(deps?: DriveServiceDeps): string {
  return deps?.encryptionKeyHex ?? env.INTEGRATION_ENCRYPTION_KEY;
}

/** True when the selected provider's key is configured. */
export function isDriveConfigured(deps?: DriveServiceDeps): boolean {
  const oauth = effectiveOAuth(deps);
  const key = effectiveKey(deps);
  return oauth.clientId !== '' && oauth.clientSecret !== '' && oauth.redirectUri !== '' && key !== '';
}

interface ConnectionRow {
  id: string;
  status: ApFlowDriveConnectionStatus;
  google_account_email: string | null;
  folder_id: string | null;
  folder_name: string | null;
  last_synced_at: Date | null;
  last_sync_error: string | null;
  imported_file_count: string;
  skipped_file_count: string;
  connected_by: string;
  created_at: Date;
  updated_at: Date;
}

function toConnection(row: ConnectionRow): ApFlowDriveConnection {
  return {
    id: row.id,
    status: row.status,
    googleAccountEmail: row.google_account_email,
    folderId: row.folder_id,
    folderName: row.folder_name,
    lastSyncedAt: row.last_synced_at === null ? null : row.last_synced_at.toISOString(),
    lastSyncError: row.last_sync_error,
    importedFileCount: Number(row.imported_file_count),
    skippedFileCount: Number(row.skipped_file_count),
    connectedBy: row.connected_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Never selects refresh_token_ciphertext, pkce_verifier_ciphertext, or
 * oauth_state_sha256 — those never leave this file.
 */
export async function getConnection(orgId: string): Promise<ApFlowDriveConnection | null> {
  const { rows } = await pool.query<ConnectionRow>(
    `SELECT c.id, c.status, c.google_account_email, c.folder_id, c.folder_name,
            c.last_synced_at, c.last_sync_error, c.connected_by, c.created_at, c.updated_at,
            COALESCE((SELECT count(*) FROM ap_flow_drive_files f
                       WHERE f.org_id = c.org_id AND f.connection_id = c.id AND f.status = 'IMPORTED'), 0) AS imported_file_count,
            COALESCE((SELECT count(*) FROM ap_flow_drive_files f
                       WHERE f.org_id = c.org_id AND f.connection_id = c.id AND f.status = 'SKIPPED'), 0) AS skipped_file_count
       FROM ap_flow_drive_connections c
      WHERE c.org_id = $1`,
    [orgId],
  );
  const row = rows[0];
  return row === undefined ? null : toConnection(row);
}

export async function startConnect(
  orgId: string,
  userId: string,
  deps?: DriveServiceDeps,
): Promise<{ authorizationUrl: string }> {
  if (!isDriveConfigured(deps)) {
    throw new ApiError(503, 'Google Drive is not configured on this server');
  }

  const oauth = effectiveOAuth(deps);
  const key = effectiveKey(deps);
  const state = randomUrlToken();
  const verifier = randomUrlToken();

  await withTransaction(async (client) => {
    const { rows } = await client.query<{ status: ApFlowDriveConnectionStatus }>(
      'SELECT status FROM ap_flow_drive_connections WHERE org_id = $1 FOR UPDATE',
      [orgId],
    );
    const existingStatus = rows[0]?.status;
    if (existingStatus !== undefined && !canTransitionApFlowDriveConnection(existingStatus, 'PENDING_AUTH')) {
      throw new ApiError(409, `Cannot start a connection in status ${existingStatus}`);
    }

    await client.query(
      `INSERT INTO ap_flow_drive_connections (org_id, status, oauth_state_sha256, pkce_verifier_ciphertext, oauth_state_expires_at, connected_by)
       VALUES ($1, 'PENDING_AUTH', $2, $3, now() + make_interval(mins => $4), $5)
       ON CONFLICT (org_id) DO UPDATE
         SET status = 'PENDING_AUTH',
             oauth_state_sha256 = EXCLUDED.oauth_state_sha256,
             pkce_verifier_ciphertext = EXCLUDED.pkce_verifier_ciphertext,
             oauth_state_expires_at = EXCLUDED.oauth_state_expires_at,
             connected_by = EXCLUDED.connected_by`,
      [orgId, sha256Hex(state), encryptSecret(verifier, key), AP_FLOW_DRIVE_OAUTH_STATE_TTL_MINUTES, userId],
    );
  });

  return { authorizationUrl: buildAuthorizationUrl(oauth, state, pkceChallengeS256(verifier)) };
}

/**
 * RULE-1 EXCEPTION #1: this lookup carries no org_id predicate. The Google
 * OAuth redirect arrives with no session — the 256-bit `state` value IS the
 * credential, and it was bound to exactly one org by an authenticated
 * OWNER/ADMIN inside startConnect. The org comes from the matched row,
 * never from the request.
 *
 * Claim first, network second: the state is atomically cleared (and thus
 * single-use) BEFORE any call to Google, and no transaction is held open
 * across that call (guardrails rule 5).
 */
export async function completeConnect(
  state: string,
  code: string,
  deps?: DriveServiceDeps,
): Promise<{ orgId: string }> {
  const key = effectiveKey(deps);

  // SELECT ... FOR UPDATE, then a separate UPDATE, both inside one
  // transaction — NOT a single UPDATE ... RETURNING. RETURNING reflects
  // POST-update values, so nulling pkce_verifier_ciphertext in the same
  // statement that returns it would always return NULL; nulling only the
  // other two columns there would violate chk_ap_flow_drive_connections_
  // state_complete, which requires all three null together. The row lock
  // from FOR UPDATE makes this atomic against a second, concurrent
  // completeConnect for the same state: it blocks until this transaction
  // commits, then finds oauth_state_sha256 already NULL and correctly 400s.
  const claimed = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; org_id: string; pkce_verifier_ciphertext: string }>(
      `SELECT id, org_id, pkce_verifier_ciphertext FROM ap_flow_drive_connections
        WHERE oauth_state_sha256 = $1 AND status = 'PENDING_AUTH' AND oauth_state_expires_at > now()
        FOR UPDATE`,
      [sha256Hex(state)],
    );
    const row = rows[0];
    if (row === undefined) return undefined;

    await client.query(
      `UPDATE ap_flow_drive_connections
          SET oauth_state_sha256 = NULL, pkce_verifier_ciphertext = NULL, oauth_state_expires_at = NULL
        WHERE org_id = $1 AND id = $2`,
      [row.org_id, row.id],
    );
    return row;
  });

  if (claimed === undefined) {
    throw new ApiError(400, 'Invalid or expired authorization state');
  }

  const oauth = effectiveOAuth(deps);
  let accessToken: string;
  let refreshToken: string;
  let email: string;
  try {
    const verifier = decryptSecret(claimed.pkce_verifier_ciphertext, key);
    const exchanged = await exchangeCode(oauth, code, verifier, deps?.fetchImpl);
    accessToken = exchanged.accessToken;
    refreshToken = exchanged.refreshToken;
    email = await getAccountEmail(accessToken, deps?.fetchImpl);
  } catch (err) {
    if (err instanceof GoogleDriveError) {
      throw new ApiError(502, 'Google rejected the authorization');
    }
    throw err;
  }

  const connected = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE ap_flow_drive_connections
          SET status = 'CONNECTED', refresh_token_ciphertext = $3, google_account_email = $4, last_sync_error = NULL
        WHERE org_id = $1 AND id = $2 AND status = 'PENDING_AUTH'`,
      [claimed.org_id, claimed.id, encryptSecret(refreshToken, key), email.toLowerCase()],
    );
    return result.rowCount === 1;
  });

  // The claim step already verified PENDING_AUTH moments earlier with no
  // code in between that could change it, so 0 rows here means the row was
  // deleted (disconnect) in the window while the Google round-trip was in
  // flight — report it honestly rather than a false success.
  if (!connected) {
    throw new ApiError(409, 'Google Drive was disconnected during authorization — try again');
  }

  return { orgId: claimed.org_id };
}

export async function setFolder(
  orgId: string,
  input: string,
  deps?: DriveServiceDeps,
): Promise<ApFlowDriveConnection> {
  const { rows } = await pool.query<{ status: ApFlowDriveConnectionStatus; refresh_token_ciphertext: string | null }>(
    'SELECT status, refresh_token_ciphertext FROM ap_flow_drive_connections WHERE org_id = $1',
    [orgId],
  );
  const row = rows[0];
  if (row === undefined || row.status !== 'CONNECTED' || row.refresh_token_ciphertext === null) {
    throw new ApiError(409, 'Connect Google Drive before choosing a folder');
  }

  const folderId = parseFolderInput(input);
  if (folderId === null) {
    throw new ApiError(400, 'Enter a Google Drive folder link or ID');
  }

  const oauth = effectiveOAuth(deps);
  const key = effectiveKey(deps);

  let accessToken: string;
  try {
    accessToken = await refreshAccessToken(oauth, decryptSecret(row.refresh_token_ciphertext, key), deps?.fetchImpl);
  } catch (err) {
    if (err instanceof GoogleDriveError && err.code === 'INVALID_GRANT') {
      await pool.query(
        `UPDATE ap_flow_drive_connections
            SET status = 'NEEDS_REAUTH', last_sync_error = 'Google Drive access was revoked — reconnect'
          WHERE org_id = $1 AND status = 'CONNECTED'`,
        [orgId],
      );
      throw new ApiError(409, 'Google Drive access was revoked — reconnect');
    }
    throw err;
  }

  const folder = await getFolder(accessToken, folderId, deps?.fetchImpl);
  if (folder === null) {
    throw new ApiError(404, 'Drive folder not found or not shared with the connected account');
  }
  if (folder.mimeType !== 'application/vnd.google-apps.folder') {
    throw new ApiError(422, 'That Drive item is not a folder');
  }

  // org_id is UNIQUE on this table (ux_ap_flow_drive_connections_org), so
  // this predicate alone identifies the row; status = 'CONNECTED' is
  // re-checked here rather than trusted from the read above.
  await withTransaction((client) =>
    client.query(
      `UPDATE ap_flow_drive_connections
          SET folder_id = $2, folder_name = $3
        WHERE org_id = $1 AND status = 'CONNECTED'`,
      [orgId, folder.id, folder.name],
    ),
  );

  const updated = await getConnection(orgId);
  if (updated === null) throw new ApiError(404, 'Google Drive is not connected');
  return updated;
}

export async function requestSync(orgId: string): Promise<void> {
  const { rows } = await pool.query<{ id: string; status: ApFlowDriveConnectionStatus; folder_id: string | null }>(
    'SELECT id, status, folder_id FROM ap_flow_drive_connections WHERE org_id = $1',
    [orgId],
  );
  const row = rows[0];
  if (row === undefined || row.status !== 'CONNECTED') {
    throw new ApiError(409, 'Connect Google Drive before syncing');
  }
  if (row.folder_id === null) {
    throw new ApiError(409, 'Choose a Drive folder before syncing');
  }

  await enqueue(
    'ap-flow-drive-sync',
    { orgId, connectionId: row.id },
    { jobId: `ap-flow-drive-sync-${row.id}-manual-${String(Date.now())}` },
  );
}

export async function disconnect(orgId: string, deps?: DriveServiceDeps): Promise<void> {
  const ciphertext = await withTransaction(async (client) => {
    const { rows } = await client.query<{ refresh_token_ciphertext: string | null }>(
      'DELETE FROM ap_flow_drive_connections WHERE org_id = $1 RETURNING refresh_token_ciphertext',
      [orgId],
    );
    return rows[0];
  });

  if (ciphertext === undefined) {
    throw new ApiError(404, 'Google Drive is not connected');
  }

  // Post-COMMIT network is acceptable here: not financial, best-effort, and
  // the grant is already useless locally once the ciphertext is gone.
  const key = effectiveKey(deps);
  if (ciphertext.refresh_token_ciphertext !== null && key !== '') {
    try {
      await revokeTokenSafely(ciphertext.refresh_token_ciphertext, key, deps?.fetchImpl);
    } catch (err) {
      console.error('[ap-flow-drive] failed to revoke a refresh token:', err);
    }
  }
}

async function revokeTokenSafely(ciphertext: string, key: string, fetchImpl?: FetchLike): Promise<void> {
  const token = decryptSecret(ciphertext, key);
  await revokeToken(token, fetchImpl);
}

/**
 * RULE-1 EXCEPTION #2: reads across every organization. This is the
 * scheduler sweep, the same status platform-level `verifyIntegrity` already
 * carries — it returns identifiers only, and every downstream call
 * (syncConnection) re-scopes by that row's own org_id.
 */
export async function listConnectionsDueForSync(): Promise<{ orgId: string; connectionId: string }[]> {
  const { rows } = await pool.query<{ org_id: string; id: string }>(
    `SELECT org_id, id FROM ap_flow_drive_connections
      WHERE status = 'CONNECTED' AND folder_id IS NOT NULL
      ORDER BY id`,
  );
  return rows.map((row) => ({ orgId: row.org_id, connectionId: row.id }));
}

export async function syncConnection(
  orgId: string,
  connectionId: string,
  deps?: DriveServiceDeps,
): Promise<{ imported: number; skipped: number }> {
  const { rows } = await pool.query<{
    status: ApFlowDriveConnectionStatus;
    folder_id: string | null;
    connected_by: string;
    refresh_token_ciphertext: string | null;
  }>(
    'SELECT status, folder_id, connected_by, refresh_token_ciphertext FROM ap_flow_drive_connections WHERE org_id = $1 AND id = $2',
    [orgId, connectionId],
  );
  const row = rows[0];
  if (row === undefined || row.status !== 'CONNECTED' || row.folder_id === null || row.refresh_token_ciphertext === null) {
    return { imported: 0, skipped: 0 };
  }

  const oauth = effectiveOAuth(deps);
  const key = effectiveKey(deps);

  let accessToken: string;
  try {
    accessToken = await refreshAccessToken(oauth, decryptSecret(row.refresh_token_ciphertext, key), deps?.fetchImpl);
  } catch (err) {
    if (err instanceof GoogleDriveError && err.code === 'INVALID_GRANT') {
      await pool.query(
        `UPDATE ap_flow_drive_connections
            SET status = 'NEEDS_REAUTH', last_sync_error = 'Google Drive access was revoked — reconnect'
          WHERE org_id = $1 AND id = $2 AND status = 'CONNECTED'`,
        [orgId, connectionId],
      );
    }
    return { imported: 0, skipped: 0 };
  }

  const files = await listFolderFiles(accessToken, row.folder_id, deps?.fetchImpl);
  const fileIds = files.map((f) => f.id);
  const known =
    fileIds.length === 0
      ? new Set<string>()
      : new Set(
          (
            await pool.query<{ drive_file_id: string }>(
              'SELECT drive_file_id FROM ap_flow_drive_files WHERE org_id = $1 AND drive_file_id = ANY($2::text[])',
              [orgId, fileIds],
            )
          ).rows.map((r) => r.drive_file_id),
        );

  const pending = files.filter((f) => !known.has(f.id)).slice(0, AP_FLOW_DRIVE_MAX_FILES_PER_SYNC);

  let imported = 0;
  let skipped = 0;
  let lastError: string | null = null;

  for (const file of pending) {
    const name = file.name.trim() === '' ? `drive-${file.id}` : file.name.slice(0, 255);

    if (file.sizeBytes !== null && file.sizeBytes > MAX_UPLOAD_BYTES) {
      await recordDriveFile(orgId, connectionId, file, name, 'SKIPPED', 'File exceeds the 10 MB limit', null);
      skipped += 1;
      continue;
    }

    try {
      const buffer = await downloadFile(accessToken, file.id, MAX_UPLOAD_BYTES, deps?.fetchImpl);
      const { document } = await apFlowDocumentService.captureFile(orgId, row.connected_by, {
        buffer,
        originalname: name,
      });
      await recordDriveFile(orgId, connectionId, file, name, 'IMPORTED', null, document.id);
      imported += 1;
    } catch (err) {
      if (err instanceof GoogleDriveError && err.code === 'TOO_LARGE') {
        await recordDriveFile(orgId, connectionId, file, name, 'SKIPPED', 'File exceeds the 10 MB limit', null);
        skipped += 1;
      } else if (err instanceof ApiError && (err.status === 415 || err.status === 422)) {
        await recordDriveFile(orgId, connectionId, file, name, 'SKIPPED', err.message, null);
        skipped += 1;
      } else {
        lastError = err instanceof Error ? err.message : 'Unknown error';
      }
    }
  }

  await pool.query(
    `UPDATE ap_flow_drive_connections SET last_synced_at = now(), last_sync_error = $3 WHERE org_id = $1 AND id = $2`,
    [orgId, connectionId, lastError === null ? null : lastError.slice(0, 1000)],
  );

  return { imported, skipped };
}

async function recordDriveFile(
  orgId: string,
  connectionId: string,
  file: { id: string; mimeType: string; md5Checksum: string | null; modifiedTime: string | null },
  name: string,
  status: 'IMPORTED' | 'SKIPPED',
  skipReason: string | null,
  apFlowDocumentId: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO ap_flow_drive_files
       (org_id, connection_id, drive_file_id, name, mime_type, md5_checksum, drive_modified_at, status, skip_reason, ap_flow_document_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (org_id, drive_file_id) DO NOTHING`,
    [orgId, connectionId, file.id, name, file.mimeType, file.md5Checksum, file.modifiedTime, status, skipReason, apFlowDocumentId],
  );
}
