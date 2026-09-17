import { pool } from '../../db/connect.js';
import { ApiError } from '../../utils/apiError.js';
import { enqueue } from '../../queue/queues.js';
import * as accountService from '../ledger-core/accountService.js';
import { getConnection, getAccessToken } from './driveConnectionService.js';
import type { DriveServiceDeps } from './driveConnectionService.js';
import { getFolder as getDriveFolderMetadata, parseFolderInput } from './googleDriveClient.js';
import type { DriveColumnMap, DriveDateFormat, DriveFolder, DriveFolderPurpose } from '../../types/integrations.js';

const PG_UNIQUE_VIOLATION = '23505';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

/**
 * CRUD for the folders a Drive connection watches. A connection is the
 * credential; a folder is one watched location plus what it is FOR — the
 * purpose that routes its files to an app (driveIntakeDispatcher) and, for
 * BANK_STATEMENT, the ledger account and CSV shape a manual import would
 * otherwise ask for on the form each time.
 *
 * `ledgerAccountId` carries no REFERENCES to LedgerCore's `accounts` table
 * (guardrails rules 8 and 16 collide, 16 wins — migration 053's comment on
 * the column states the identical ruling). Validity is checked here through
 * accountService's own public functions, never by querying `accounts`
 * directly — the rule-16 seam this file is required to keep.
 */

export interface CreateDriveFolderInput {
  purpose: DriveFolderPurpose;
  folder: string;
  ledgerAccountId: string | null;
  dateFormat: DriveDateFormat | null;
  columnMap: DriveColumnMap | null;
}

/**
 * NOT `Partial<CreateDriveFolderInput>`: under `exactOptionalPropertyTypes`,
 * `Partial<T>`'s optional keys forbid an explicitly-present `undefined`
 * value, but zod's `.optional()` output (what `updateDriveFolderSchema`
 * actually produces) carries fields that are present-with-value-undefined,
 * not merely absent. This shape matches that inferred output directly.
 */
export interface UpdateDriveFolderInput {
  purpose?: DriveFolderPurpose | undefined;
  ledgerAccountId?: string | null | undefined;
  dateFormat?: DriveDateFormat | null | undefined;
  columnMap?: DriveColumnMap | null | undefined;
  isActive?: boolean | undefined;
}

interface FolderRow {
  id: string;
  purpose: DriveFolderPurpose;
  folder_id: string;
  folder_name: string;
  is_active: boolean;
  ledger_account_id: string | null;
  date_format: DriveDateFormat | null;
  column_map: DriveColumnMap | null;
  last_synced_at: Date | null;
  last_sync_error: string | null;
  imported_file_count: string;
  skipped_file_count: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

const FOLDER_SELECT = `
  SELECT f.id, f.purpose, f.folder_id, f.folder_name, f.is_active,
         f.ledger_account_id, f.date_format, f.column_map,
         f.last_synced_at, f.last_sync_error, f.created_by, f.created_at, f.updated_at,
         COALESCE(cnt.imported_file_count, 0) AS imported_file_count,
         COALESCE(cnt.skipped_file_count, 0) AS skipped_file_count
    FROM integration_drive_folders f
    LEFT JOIN (
      SELECT folder_id,
             count(*) FILTER (WHERE status = 'IMPORTED') AS imported_file_count,
             count(*) FILTER (WHERE status = 'SKIPPED') AS skipped_file_count
        FROM integration_drive_files
       WHERE org_id = $1
       GROUP BY folder_id
    ) cnt ON cnt.folder_id = f.id
`;

/**
 * Resolves `ledgerAccountCode` through accountService for each BANK_STATEMENT
 * row (N+1, deliberately) rather than joining `accounts` in FOLDER_SELECT
 * above — this file must never query another app's table directly.
 */
async function toFolder(orgId: string, row: FolderRow): Promise<DriveFolder> {
  let ledgerAccountCode: string | null = null;
  if (row.ledger_account_id !== null) {
    try {
      const account = await accountService.getAccountById(orgId, row.ledger_account_id);
      ledgerAccountCode = account.code;
    } catch {
      // The account was deleted or moved out of reach after the folder was
      // configured — leave the code null rather than fail the whole list.
      ledgerAccountCode = null;
    }
  }

  return {
    id: row.id,
    purpose: row.purpose,
    folderId: row.folder_id,
    folderName: row.folder_name,
    isActive: row.is_active,
    ledgerAccountId: row.ledger_account_id,
    ledgerAccountCode,
    dateFormat: row.date_format,
    columnMap: row.column_map,
    lastSyncedAt: row.last_synced_at === null ? null : row.last_synced_at.toISOString(),
    lastSyncError: row.last_sync_error,
    importedFileCount: Number(row.imported_file_count),
    skippedFileCount: Number(row.skipped_file_count),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listFolders(orgId: string): Promise<DriveFolder[]> {
  const { rows } = await pool.query<FolderRow>(`${FOLDER_SELECT} WHERE f.org_id = $1 ORDER BY f.created_at`, [
    orgId,
  ]);
  return Promise.all(rows.map((row) => toFolder(orgId, row)));
}

export async function getFolder(orgId: string, folderRowId: string): Promise<DriveFolder> {
  const { rows } = await pool.query<FolderRow>(`${FOLDER_SELECT} WHERE f.org_id = $1 AND f.id = $2`, [
    orgId,
    folderRowId,
  ]);
  const row = rows[0];
  // 404, never 403 — a 403 would confirm the row exists in another org.
  if (row === undefined) throw new ApiError(404, 'Folder not found');
  return toFolder(orgId, row);
}

/** Mirrors bankImportService.importStatement's own account gates, so a bad config fails at setup time, not at 3am. */
async function assertUsableBankAccount(orgId: string, accountId: string): Promise<void> {
  let account;
  try {
    account = await accountService.getAccountById(orgId, accountId);
  } catch {
    throw new ApiError(422, 'Bank account not found');
  }
  if (!account.isPostable) {
    throw new ApiError(422, `Account ${account.code} is a header account and cannot be posted to`);
  }
  if (account.type !== 'Asset') {
    throw new ApiError(422, `Account ${account.code} is not an Asset account`);
  }
}

export async function createFolder(
  orgId: string,
  userId: string,
  input: CreateDriveFolderInput,
  deps?: DriveServiceDeps,
): Promise<DriveFolder> {
  const connection = await getConnection(orgId);
  if (connection === null || connection.status !== 'CONNECTED') {
    throw new ApiError(409, 'Connect Google Drive before adding a folder');
  }

  const driveFolderId = parseFolderInput(input.folder);
  if (driveFolderId === null) {
    throw new ApiError(400, 'Enter a Google Drive folder link or ID');
  }

  const accessToken = await getAccessToken(orgId, connection, deps);
  const folder = await getDriveFolderMetadata(accessToken, driveFolderId, deps?.fetchImpl);
  if (folder === null) {
    const whoToShareWith =
      connection.authMode === 'SERVICE_ACCOUNT' && connection.googleAccountEmail !== null
        ? connection.googleAccountEmail
        : 'the connected account';
    throw new ApiError(404, `Drive folder not found or not shared with ${whoToShareWith}`);
  }
  if (folder.mimeType !== 'application/vnd.google-apps.folder') {
    throw new ApiError(422, 'That Drive item is not a folder');
  }

  if (input.purpose === 'BANK_STATEMENT') {
    if (input.ledgerAccountId === null || input.dateFormat === null) {
      throw new ApiError(422, 'A bank statement folder needs a ledger account and a date format');
    }
    await assertUsableBankAccount(orgId, input.ledgerAccountId);
  }

  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO integration_drive_folders
         (org_id, connection_id, purpose, folder_id, folder_name, ledger_account_id, date_format, column_map, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        orgId,
        connection.id,
        input.purpose,
        folder.id,
        folder.name,
        input.purpose === 'BANK_STATEMENT' ? input.ledgerAccountId : null,
        input.purpose === 'BANK_STATEMENT' ? input.dateFormat : null,
        input.purpose === 'BANK_STATEMENT' ? input.columnMap : null,
        userId,
      ],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new ApiError(500, 'Failed to create folder');
    return await getFolder(orgId, id);
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw new ApiError(409, 'That folder is already connected for this purpose');
    }
    throw err;
  }
}

export async function updateFolder(
  orgId: string,
  folderRowId: string,
  input: UpdateDriveFolderInput,
): Promise<DriveFolder> {
  const existing = await getFolder(orgId, folderRowId);

  const purpose = input.purpose ?? existing.purpose;
  const ledgerAccountId = input.ledgerAccountId !== undefined ? input.ledgerAccountId : existing.ledgerAccountId;
  const dateFormat = input.dateFormat !== undefined ? input.dateFormat : existing.dateFormat;
  const columnMap = input.columnMap !== undefined ? input.columnMap : existing.columnMap;
  const isActive = input.isActive ?? existing.isActive;

  if (purpose === 'BANK_STATEMENT') {
    if (ledgerAccountId === null || dateFormat === null) {
      throw new ApiError(422, 'A bank statement folder needs a ledger account and a date format');
    }
    if (ledgerAccountId !== existing.ledgerAccountId) {
      await assertUsableBankAccount(orgId, ledgerAccountId);
    }
  }

  await pool.query(
    `UPDATE integration_drive_folders
        SET purpose = $3, ledger_account_id = $4, date_format = $5, column_map = $6, is_active = $7
      WHERE org_id = $1 AND id = $2`,
    [
      orgId,
      folderRowId,
      purpose,
      purpose === 'BANK_STATEMENT' ? ledgerAccountId : null,
      purpose === 'BANK_STATEMENT' ? dateFormat : null,
      purpose === 'BANK_STATEMENT' ? columnMap : null,
      isActive,
    ],
  );

  return getFolder(orgId, folderRowId);
}

export async function deleteFolder(orgId: string, folderRowId: string): Promise<void> {
  const result = await pool.query('DELETE FROM integration_drive_folders WHERE org_id = $1 AND id = $2', [
    orgId,
    folderRowId,
  ]);
  if (result.rowCount === 0) throw new ApiError(404, 'Folder not found');
}

export async function requestFolderSync(orgId: string, folderRowId: string): Promise<void> {
  // Confirms the folder exists in this org (404s otherwise) before queuing —
  // the same "read to authorize, then act" shape getFolder already gives.
  await getFolder(orgId, folderRowId);
  await enqueue(
    'integration-drive-sync',
    { orgId, folderId: folderRowId },
    { jobId: `integration-drive-sync-${folderRowId}-manual-${String(Date.now())}` },
  );
}
