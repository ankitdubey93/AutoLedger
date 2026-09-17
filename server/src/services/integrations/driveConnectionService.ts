import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { env } from '../../config/env.js';
import { INTEGRATION_DRIVE_OAUTH_STATE_TTL_MINUTES } from '../../config/constants.js';
import { decryptSecret, encryptSecret } from '../../utils/secretBox.js';
import { pkceChallengeS256, randomUrlToken, sha256Hex } from '../../utils/pkce.js';
import {
  buildAuthorizationUrl,
  exchangeCode,
  getAccountEmail,
  GoogleDriveError,
  refreshAccessToken,
  revokeToken,
} from './googleDriveClient.js';
import type { FetchLike, GoogleOAuthConfig } from './googleDriveClient.js';
import { getServiceAccountAccessToken } from './googleServiceAccount.js';
import type { ServiceAccountConfig } from './googleServiceAccount.js';
import { canTransitionDriveConnection } from '../../types/integrations.js';
import type { DriveAuthMode, DriveConnection, DriveConnectionStatus } from '../../types/integrations.js';

/**
 * Google Drive connection lifecycle — Phase 19.3. A connection is one per
 * org (UNIQUE (org_id)) and authenticates one of two ways:
 *
 * - SERVICE_ACCOUNT (recommended): the tenant shares a folder with the
 *   server's own service-account address. No consent screen, no per-org
 *   token, no Google app verification.
 * - OAUTH (retained from 19.2): a per-org OAuth 2.0 + PKCE consent flow,
 *   storing an encrypted refresh token.
 *
 * Folders themselves live in driveFolderService — a connection is just the
 * credential; syncing a folder lives in driveSyncService.
 *
 * Every function takes `orgId` first and every statement carries an
 * `org_id` predicate (guardrails rule 1), with exactly two documented
 * exceptions: `completeConnect`'s state lookup below (the OAuth redirect
 * carries no session — the state IS the credential) and
 * `driveSyncService.listFoldersDueForSync` (the scheduler sweep, ids only,
 * every downstream call re-scopes by that row's own org_id).
 *
 * TOKEN HYGIENE: no log line, error message, or return value in this file
 * ever includes a token, verifier, state, key, or ciphertext.
 */

export interface DriveServiceDeps {
  fetchImpl?: FetchLike;
  oauth?: GoogleOAuthConfig;
  serviceAccount?: ServiceAccountConfig;
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

function effectiveServiceAccount(deps?: DriveServiceDeps): ServiceAccountConfig {
  return (
    deps?.serviceAccount ?? {
      clientEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      privateKeyPem: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
    }
  );
}

function effectiveKey(deps?: DriveServiceDeps): string {
  return deps?.encryptionKeyHex ?? env.INTEGRATION_ENCRYPTION_KEY;
}

export function isOAuthConfigured(deps?: DriveServiceDeps): boolean {
  const oauth = effectiveOAuth(deps);
  const key = effectiveKey(deps);
  return oauth.clientId !== '' && oauth.clientSecret !== '' && oauth.redirectUri !== '' && key !== '';
}

export function isServiceAccountConfigured(deps?: DriveServiceDeps): boolean {
  const sa = effectiveServiceAccount(deps);
  return sa.clientEmail !== '' && sa.privateKeyPem !== '';
}

/** Fed to `GET /integrations/drive` so the client can offer the right connect action(s). */
export function driveModes(deps?: DriveServiceDeps): {
  oauth: boolean;
  serviceAccount: boolean;
  serviceAccountEmail: string | null;
} {
  const sa = effectiveServiceAccount(deps);
  return {
    oauth: isOAuthConfigured(deps),
    serviceAccount: isServiceAccountConfigured(deps),
    serviceAccountEmail: sa.clientEmail === '' ? null : sa.clientEmail,
  };
}

interface ConnectionRow {
  id: string;
  status: DriveConnectionStatus;
  auth_mode: DriveAuthMode;
  google_account_email: string | null;
  connected_by: string;
  created_at: Date;
  updated_at: Date;
}

function toConnection(row: ConnectionRow): DriveConnection {
  return {
    id: row.id,
    status: row.status,
    authMode: row.auth_mode,
    googleAccountEmail: row.google_account_email,
    connectedBy: row.connected_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Never selects refresh_token_ciphertext, pkce_verifier_ciphertext, or
 * oauth_state_sha256 — those never leave this file. Folder-derived counts
 * moved to driveFolderService.listFolders in 19.3; a connection alone no
 * longer carries them.
 */
export async function getConnection(orgId: string): Promise<DriveConnection | null> {
  const { rows } = await pool.query<ConnectionRow>(
    `SELECT id, status, auth_mode, google_account_email, connected_by, created_at, updated_at
       FROM integration_drive_connections
      WHERE org_id = $1`,
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
  if (!isOAuthConfigured(deps)) {
    throw new ApiError(503, 'Google Drive is not configured on this server');
  }

  const oauth = effectiveOAuth(deps);
  const key = effectiveKey(deps);
  const state = randomUrlToken();
  const verifier = randomUrlToken();

  await withTransaction(async (client) => {
    const { rows } = await client.query<{ status: DriveConnectionStatus }>(
      'SELECT status FROM integration_drive_connections WHERE org_id = $1 FOR UPDATE',
      [orgId],
    );
    const existingStatus = rows[0]?.status;
    if (existingStatus !== undefined && !canTransitionDriveConnection(existingStatus, 'PENDING_AUTH')) {
      throw new ApiError(409, `Cannot start a connection in status ${existingStatus}`);
    }

    await client.query(
      `INSERT INTO integration_drive_connections
         (org_id, status, auth_mode, oauth_state_sha256, pkce_verifier_ciphertext, oauth_state_expires_at, connected_by)
       VALUES ($1, 'PENDING_AUTH', 'OAUTH', $2, $3, now() + make_interval(mins => $4), $5)
       ON CONFLICT (org_id) DO UPDATE
         SET status = 'PENDING_AUTH',
             auth_mode = 'OAUTH',
             oauth_state_sha256 = EXCLUDED.oauth_state_sha256,
             pkce_verifier_ciphertext = EXCLUDED.pkce_verifier_ciphertext,
             oauth_state_expires_at = EXCLUDED.oauth_state_expires_at,
             connected_by = EXCLUDED.connected_by,
             refresh_token_ciphertext = NULL`,
      [orgId, sha256Hex(state), encryptSecret(verifier, key), INTEGRATION_DRIVE_OAUTH_STATE_TTL_MINUTES, userId],
    );
  });

  return { authorizationUrl: buildAuthorizationUrl(oauth, state, pkceChallengeS256(verifier)) };
}

/**
 * RULE-1 EXCEPTION: this lookup carries no org_id predicate. The Google
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
  // other two columns there would violate
  // chk_integration_drive_connections_state_complete, which requires all
  // three null together. The row lock from FOR UPDATE makes this atomic
  // against a second, concurrent completeConnect for the same state: it
  // blocks until this transaction commits, then finds oauth_state_sha256
  // already NULL and correctly 400s.
  const claimed = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; org_id: string; pkce_verifier_ciphertext: string }>(
      `SELECT id, org_id, pkce_verifier_ciphertext FROM integration_drive_connections
        WHERE oauth_state_sha256 = $1 AND status = 'PENDING_AUTH' AND oauth_state_expires_at > now()
        FOR UPDATE`,
      [sha256Hex(state)],
    );
    const row = rows[0];
    if (row === undefined) return undefined;

    await client.query(
      `UPDATE integration_drive_connections
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
  let refreshToken: string;
  let email: string;
  try {
    const verifier = decryptSecret(claimed.pkce_verifier_ciphertext, key);
    const exchanged = await exchangeCode(oauth, code, verifier, deps?.fetchImpl);
    refreshToken = exchanged.refreshToken;
    email = await getAccountEmail(exchanged.accessToken, deps?.fetchImpl);
  } catch (err) {
    if (err instanceof GoogleDriveError) {
      throw new ApiError(502, 'Google rejected the authorization');
    }
    throw err;
  }

  const connected = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE integration_drive_connections
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

/**
 * No network call, no consent, no OAuth state — the connection is CONNECTED
 * the instant this returns. Refuses to silently discard an existing OAuth
 * connection's stored refresh token; the caller must disconnect first.
 */
export async function connectServiceAccount(
  orgId: string,
  userId: string,
  deps?: DriveServiceDeps,
): Promise<DriveConnection> {
  if (!isServiceAccountConfigured(deps)) {
    throw new ApiError(503, 'Google Drive service account is not configured on this server');
  }

  const sa = effectiveServiceAccount(deps);

  await withTransaction(async (client) => {
    const { rows } = await client.query<{ auth_mode: DriveAuthMode }>(
      'SELECT auth_mode FROM integration_drive_connections WHERE org_id = $1 FOR UPDATE',
      [orgId],
    );
    const existing = rows[0];
    if (existing !== undefined && existing.auth_mode === 'OAUTH') {
      throw new ApiError(409, 'Disconnect the existing Google account first');
    }

    await client.query(
      `INSERT INTO integration_drive_connections
         (org_id, status, auth_mode, google_account_email, connected_by)
       VALUES ($1, 'CONNECTED', 'SERVICE_ACCOUNT', $2, $3)
       ON CONFLICT (org_id) DO UPDATE
         SET status = 'CONNECTED',
             auth_mode = 'SERVICE_ACCOUNT',
             google_account_email = EXCLUDED.google_account_email,
             connected_by = EXCLUDED.connected_by,
             refresh_token_ciphertext = NULL,
             oauth_state_sha256 = NULL,
             pkce_verifier_ciphertext = NULL,
             oauth_state_expires_at = NULL,
             last_sync_error = NULL`,
      [orgId, sa.clientEmail.toLowerCase(), userId],
    );
  });

  const connection = await getConnection(orgId);
  if (connection === null) throw new ApiError(404, 'Google Drive is not connected');
  return connection;
}

/**
 * The one place either auth mode resolves to a bearer token. Callers
 * (driveFolderService, driveSyncService) never touch a refresh token,
 * ciphertext, or the service-account key directly.
 */
export async function getAccessToken(
  orgId: string,
  connection: Pick<DriveConnection, 'authMode'>,
  deps?: DriveServiceDeps,
): Promise<string> {
  if (connection.authMode === 'SERVICE_ACCOUNT') {
    return getServiceAccountAccessToken(effectiveServiceAccount(deps), deps?.fetchImpl);
  }

  const { rows } = await pool.query<{ refresh_token_ciphertext: string | null }>(
    'SELECT refresh_token_ciphertext FROM integration_drive_connections WHERE org_id = $1',
    [orgId],
  );
  const ciphertext = rows[0]?.refresh_token_ciphertext;
  if (ciphertext === null || ciphertext === undefined) {
    throw new ApiError(409, 'Connect Google Drive before continuing');
  }

  const oauth = effectiveOAuth(deps);
  const key = effectiveKey(deps);

  try {
    return await refreshAccessToken(oauth, decryptSecret(ciphertext, key), deps?.fetchImpl);
  } catch (err) {
    if (err instanceof GoogleDriveError && err.code === 'INVALID_GRANT') {
      await pool.query(
        `UPDATE integration_drive_connections
            SET status = 'NEEDS_REAUTH', last_sync_error = 'Google Drive access was revoked — reconnect'
          WHERE org_id = $1 AND status = 'CONNECTED'`,
        [orgId],
      );
      throw new ApiError(409, 'Google Drive access was revoked — reconnect');
    }
    throw err;
  }
}

export async function disconnect(orgId: string, deps?: DriveServiceDeps): Promise<void> {
  const deleted = await withTransaction(async (client) => {
    const { rows } = await client.query<{ auth_mode: DriveAuthMode; refresh_token_ciphertext: string | null }>(
      'DELETE FROM integration_drive_connections WHERE org_id = $1 RETURNING auth_mode, refresh_token_ciphertext',
      [orgId],
    );
    return rows[0];
  });

  if (deleted === undefined) {
    throw new ApiError(404, 'Google Drive is not connected');
  }

  // Post-COMMIT network is acceptable here: not financial, best-effort, and
  // the grant is already useless locally once the ciphertext is gone. A
  // SERVICE_ACCOUNT connection has no grant of its own to revoke — the
  // tenant's folder share is theirs to remove, not a token this server holds.
  const key = effectiveKey(deps);
  if (deleted.auth_mode === 'OAUTH' && deleted.refresh_token_ciphertext !== null && key !== '') {
    try {
      const token = decryptSecret(deleted.refresh_token_ciphertext, key);
      await revokeToken(token, deps?.fetchImpl);
    } catch (err) {
      console.error('[integrations-drive] failed to revoke a refresh token:', err);
    }
  }
}
