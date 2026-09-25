import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * The database as the guardrail, not the service — every test here drives
 * raw SQL straight at the pool to prove migration 053's constraints and
 * triggers hold regardless of what wrote the row. Ported and extended from
 * ap-flow/captureConstraints.test.ts's three Phase 19.2 cases, now that the
 * integration is platform-level, not Capture's.
 *
 * Assert SQLSTATE, never message text — messages are free to change without
 * being a break in the actual guarantee.
 */

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';

async function errorCode(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err) {
      return typeof err.code === 'string' ? err.code : undefined;
    }
  }
  return undefined;
}

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;

async function seedConnection(
  orgId: string,
  userId: string,
  options: { authMode?: 'OAUTH' | 'SERVICE_ACCOUNT'; refreshTokenCiphertext?: string | null } = {},
): Promise<string> {
  const authMode = options.authMode ?? 'OAUTH';
  const refreshTokenCiphertext = options.refreshTokenCiphertext ?? (authMode === 'OAUTH' ? 'v1.x.x.x' : null);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO integration_drive_connections (org_id, status, auth_mode, refresh_token_ciphertext, connected_by)
     VALUES ($1, 'CONNECTED', $2, $3, $4) RETURNING id`,
    [orgId, authMode, refreshTokenCiphertext, userId],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('fixture: no connection id');
  return id;
}

async function seedFolder(
  orgId: string,
  connectionId: string,
  userId: string,
  options: { purpose?: 'VENDOR_BILL' | 'BANK_STATEMENT'; folderId?: string; ledgerAccountId?: string | null } = {},
): Promise<string> {
  const purpose = options.purpose ?? 'VENDOR_BILL';
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO integration_drive_folders (org_id, connection_id, purpose, folder_id, folder_name, ledger_account_id, date_format, created_by)
     VALUES ($1, $2, $3, $4, 'My Folder', $5, $6, $7) RETURNING id`,
    [
      orgId,
      connectionId,
      purpose,
      options.folderId ?? 'folder1234567',
      purpose === 'BANK_STATEMENT' ? (options.ledgerAccountId ?? null) : null,
      purpose === 'BANK_STATEMENT' ? 'ISO' : null,
      userId,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('fixture: no folder id');
  return id;
}

describe('integrations drive database constraints', () => {
  beforeEach(async () => {
    await resetTables();
    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;
    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
    orgB = userB.orgId;
  });

  afterAll(closePool);

  it('rejects a folder purpose outside VENDOR_BILL/BANK_STATEMENT', async () => {
    const connectionId = await seedConnection(orgA, userA.id);
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO integration_drive_folders (org_id, connection_id, purpose, folder_id, folder_name, created_by)
         VALUES ($1, $2, 'RECEIPT', 'folder1234567', 'My Folder', $3)`,
        [orgA, connectionId, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('rejects a BANK_STATEMENT folder with no ledger account', async () => {
    const connectionId = await seedConnection(orgA, userA.id);
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO integration_drive_folders (org_id, connection_id, purpose, folder_id, folder_name, date_format, created_by)
         VALUES ($1, $2, 'BANK_STATEMENT', 'folder1234567', 'My Folder', 'ISO', $3)`,
        [orgA, connectionId, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('rejects a VENDOR_BILL folder carrying a ledger account', async () => {
    const connectionId = await seedConnection(orgA, userA.id);
    const cashAccountId = (
      await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id = $1 AND code = $2', [orgA, '1110'])
    ).rows[0]?.id;

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO integration_drive_folders (org_id, connection_id, purpose, folder_id, folder_name, ledger_account_id, created_by)
         VALUES ($1, $2, 'VENDOR_BILL', 'folder1234567', 'My Folder', $3, $4)`,
        [orgA, connectionId, cashAccountId, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('rejects a SERVICE_ACCOUNT connection carrying a refresh token', async () => {
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO integration_drive_connections (org_id, status, auth_mode, refresh_token_ciphertext, connected_by)
         VALUES ($1, 'CONNECTED', 'SERVICE_ACCOUNT', 'v1.x.x.x', $2)`,
        [orgA, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('rejects a CONNECTED OAUTH connection with no refresh token', async () => {
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO integration_drive_connections (org_id, status, auth_mode, connected_by)
         VALUES ($1, 'CONNECTED', 'OAUTH', $2)`,
        [orgA, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it("rejects a folder pointing at another organization's connection", async () => {
    const connectionB = await seedConnection(orgB, userB.id);
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO integration_drive_folders (org_id, connection_id, purpose, folder_id, folder_name, created_by)
         VALUES ($1, $2, 'VENDOR_BILL', 'folder1234567', 'My Folder', $3)`,
        [orgA, connectionB, userA.id],
      ),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('rejects a second folder for the same Drive folder id and purpose in one org', async () => {
    const connectionId = await seedConnection(orgA, userA.id);
    await seedFolder(orgA, connectionId, userA.id, { folderId: 'folder1234567' });

    const code = await errorCode(() => seedFolder(orgA, connectionId, userA.id, { folderId: 'folder1234567' }));
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('rejects a second file row for the same Drive file id in one org', async () => {
    const connectionId = await seedConnection(orgA, userA.id);
    const folderId = await seedFolder(orgA, connectionId, userA.id);

    await pool.query(
      `INSERT INTO integration_drive_files (org_id, connection_id, folder_id, drive_file_id, name, mime_type, status, skip_reason)
       VALUES ($1, $2, $3, 'drivefile01', 'x.pdf', 'application/pdf', 'SKIPPED', 'too big')`,
      [orgA, connectionId, folderId],
    );

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO integration_drive_files (org_id, connection_id, folder_id, drive_file_id, name, mime_type, status, skip_reason)
         VALUES ($1, $2, $3, 'drivefile01', 'y.pdf', 'application/pdf', 'SKIPPED', 'too big')`,
        [orgA, connectionId, folderId],
      ),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('rejects a file row with result_app set but no result_entity_id', async () => {
    const connectionId = await seedConnection(orgA, userA.id);
    const folderId = await seedFolder(orgA, connectionId, userA.id);

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO integration_drive_files (org_id, connection_id, folder_id, drive_file_id, name, mime_type, status, result_app)
         VALUES ($1, $2, $3, 'drivefile02', 'x.pdf', 'application/pdf', 'IMPORTED', 'ap-flow')`,
        [orgA, connectionId, folderId],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('deleting a connection cascades its folders and files to zero rows', async () => {
    const connectionId = await seedConnection(orgA, userA.id);
    const folderId = await seedFolder(orgA, connectionId, userA.id);
    await pool.query(
      `INSERT INTO integration_drive_files (org_id, connection_id, folder_id, drive_file_id, name, mime_type, status, skip_reason)
       VALUES ($1, $2, $3, 'drivefile03', 'x.pdf', 'application/pdf', 'SKIPPED', 'too big')`,
      [orgA, connectionId, folderId],
    );

    await pool.query('DELETE FROM integration_drive_connections WHERE org_id = $1 AND id = $2', [orgA, connectionId]);

    const { rows: folderRows } = await pool.query('SELECT 1 FROM integration_drive_folders WHERE org_id = $1', [orgA]);
    const { rows: fileRows } = await pool.query('SELECT 1 FROM integration_drive_files WHERE org_id = $1', [orgA]);
    expect(folderRows).toHaveLength(0);
    expect(fileRows).toHaveLength(0);
  });
});
