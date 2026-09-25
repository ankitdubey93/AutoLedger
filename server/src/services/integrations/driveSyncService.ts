import { pool } from '../../db/connect.js';
import { ApiError } from '../../utils/apiError.js';
import {
  DRIVE_MIME_TYPES_BY_PURPOSE,
  INTEGRATION_DRIVE_CURSOR_LAG_MS,
  INTEGRATION_DRIVE_MAX_FILES_PER_SYNC,
  INTEGRATION_DRIVE_POLL_INTERVAL_MS,
  MAX_UPLOAD_BYTES,
} from '../../config/constants.js';
import { downloadFile, GoogleDriveError, listFolderFiles } from './googleDriveClient.js';
import type { DriveFile } from './googleDriveClient.js';
import { getAccessToken, getConnection } from './driveConnectionService.js';
import type { DriveServiceDeps } from './driveConnectionService.js';
import { dispatchDriveFile } from './driveIntakeDispatcher.js';
import type { DriveColumnMap, DriveDateFormat, DriveFolderPurpose } from '../../types/integrations.js';
import { MODULE_TAGS } from '../../config/modules.js';

/**
 * The Drive sweep's actual work — one org's one folder per call. Three fixes
 * over 19.2's `syncConnection`, all load-bearing at a 60-second poll:
 *
 * A. `listFoldersDueForSync` filters on `last_synced_at` — 19.2's equivalent
 *    query had no time predicate at all despite the column existing, so it
 *    relied entirely on the sweep handler's time-bucketed jobId to avoid
 *    re-enqueueing every folder every tick.
 * B. `syncFolder` claims its folder with a conditional UPDATE before doing
 *    any work, so a sync that overlaps the next tick (a real possibility at
 *    60 seconds) cannot run twice concurrently for the same folder.
 * C. Each folder carries an incremental `drive_cursor` (a modifiedTime
 *    high-water mark), advanced only when a listing came back complete and
 *    error-free — see `syncFolder`'s closing comment for why a partial or
 *    errored batch must never advance it.
 */

const REASON_MAX_CHARS = 1000;

interface DueFolder {
  orgId: string;
  folderId: string;
}

/**
 * RULE-1 EXCEPTION: reads across every organization. This is the scheduler
 * sweep — ids only, and every downstream call (syncFolder) re-scopes by that
 * row's own org_id. The identical status 19.2's `listConnectionsDueForSync`
 * carried, and the same status platform-level `verifyIntegrity` carries.
 */
export async function listFoldersDueForSync(): Promise<DueFolder[]> {
  const { rows } = await pool.query<{ org_id: string; id: string }>(
    `SELECT f.org_id, f.id
       FROM integration_drive_folders f
       JOIN integration_drive_connections c ON c.org_id = f.org_id AND c.id = f.connection_id
      WHERE f.is_active
        AND c.status = 'CONNECTED'
        AND (f.last_synced_at IS NULL OR f.last_synced_at < now() - make_interval(secs => $1))
      ORDER BY f.id`,
    [INTEGRATION_DRIVE_POLL_INTERVAL_MS / 1000],
  );
  return rows.map((row) => ({ orgId: row.org_id, folderId: row.id }));
}

interface ClaimedFolder {
  connection_id: string;
  purpose: DriveFolderPurpose;
  folder_id: string;
  ledger_account_id: string | null;
  date_format: DriveDateFormat | null;
  column_map: DriveColumnMap | null;
  drive_cursor: Date | null;
  created_by: string;
}

/**
 * Fix B, claim-at-start: a single atomic UPDATE that only succeeds if this
 * folder is active and was not already claimed within the poll interval.
 * `rowCount === 0` means either it is not due, or another worker already
 * claimed it — both are "nothing to do right now" from this caller's view.
 */
async function claimFolder(orgId: string, folderRowId: string): Promise<ClaimedFolder | null> {
  const { rows } = await pool.query<ClaimedFolder>(
    `UPDATE integration_drive_folders
        SET last_synced_at = now()
      WHERE org_id = $1 AND id = $2 AND is_active
        AND (last_synced_at IS NULL OR last_synced_at < now() - make_interval(secs => $3))
      RETURNING connection_id, purpose, folder_id, ledger_account_id, date_format, column_map, drive_cursor, created_by`,
    [orgId, folderRowId, INTEGRATION_DRIVE_POLL_INTERVAL_MS / 1000],
  );
  return rows[0] ?? null;
}

/** The RFC-3339 UTC instant `listFolderFiles`'s `modifiedSince` option expects. */
function toRfc3339(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The next `drive_cursor`, or `null` when nothing seen this call should move
 * it. Rewound by `INTEGRATION_DRIVE_CURSOR_LAG_MS` from the newest
 * `modifiedTime` observed: `files.list` is not a snapshot and Drive's
 * timestamps come from Google's clock, not ours, so a file can surface with
 * a timestamp slightly behind one already returned. The rewind re-lists a
 * small overlap each tick, which `ux_integration_drive_files_file` absorbs
 * for free, rather than stepping over a file that arrived late.
 */
function nextCursorFrom(files: readonly DriveFile[]): Date | null {
  let maxMs: number | null = null;
  for (const file of files) {
    if (file.modifiedTime === null) continue;
    const ms = Date.parse(file.modifiedTime);
    if (Number.isNaN(ms)) continue;
    if (maxMs === null || ms > maxMs) maxMs = ms;
  }
  return maxMs === null ? null : new Date(maxMs - INTEGRATION_DRIVE_CURSOR_LAG_MS);
}

async function recordFile(
  orgId: string,
  connectionId: string,
  folderRowId: string,
  file: DriveFile,
  name: string,
  outcome:
    | { status: 'IMPORTED'; resultApp: typeof MODULE_TAGS.capture | typeof MODULE_TAGS.accounting; resultEntityId: string }
    | { status: 'SKIPPED'; reason: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO integration_drive_files
       (org_id, connection_id, folder_id, drive_file_id, name, mime_type, md5_checksum, drive_modified_at,
        status, skip_reason, result_app, result_entity_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (org_id, drive_file_id) DO NOTHING`,
    [
      orgId,
      connectionId,
      folderRowId,
      file.id,
      name,
      file.mimeType,
      file.md5Checksum,
      file.modifiedTime,
      outcome.status,
      outcome.status === 'SKIPPED' ? outcome.reason : null,
      outcome.status === 'IMPORTED' ? outcome.resultApp : null,
      outcome.status === 'IMPORTED' ? outcome.resultEntityId : null,
    ],
  );
}

export async function syncFolder(
  orgId: string,
  folderRowId: string,
  deps?: DriveServiceDeps,
): Promise<{ imported: number; skipped: number }> {
  const claimed = await claimFolder(orgId, folderRowId);
  if (claimed === null) return { imported: 0, skipped: 0 };

  const connection = await getConnection(orgId);
  if (connection === null || connection.status !== 'CONNECTED') {
    return { imported: 0, skipped: 0 };
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(orgId, connection, deps);
  } catch (err) {
    // getAccessToken already flips the connection to NEEDS_REAUTH on a
    // revoked OAuth grant; either way, nothing to do this tick.
    if (err instanceof ApiError) return { imported: 0, skipped: 0 };
    throw err;
  }

  const files = await listFolderFiles(
    accessToken,
    claimed.folder_id,
    {
      mimeTypes: DRIVE_MIME_TYPES_BY_PURPOSE[claimed.purpose],
      ...(claimed.drive_cursor !== null && { modifiedSince: toRfc3339(claimed.drive_cursor) }),
      limit: INTEGRATION_DRIVE_MAX_FILES_PER_SYNC,
    },
    deps?.fetchImpl,
  );

  const fileIds = files.map((file) => file.id);
  const known =
    fileIds.length === 0
      ? new Set<string>()
      : new Set(
          (
            await pool.query<{ drive_file_id: string }>(
              'SELECT drive_file_id FROM integration_drive_files WHERE org_id = $1 AND drive_file_id = ANY($2::text[])',
              [orgId, fileIds],
            )
          ).rows.map((row) => row.drive_file_id),
        );

  const pending = files.filter((file) => !known.has(file.id)).slice(0, INTEGRATION_DRIVE_MAX_FILES_PER_SYNC);

  let imported = 0;
  let skipped = 0;
  let lastError: string | null = null;

  for (const file of pending) {
    const name = file.name.trim() === '' ? `drive-${file.id}` : file.name.slice(0, 255);

    if (file.sizeBytes !== null && file.sizeBytes > MAX_UPLOAD_BYTES) {
      await recordFile(orgId, claimed.connection_id, folderRowId, file, name, {
        status: 'SKIPPED',
        reason: 'File exceeds the 10 MB limit',
      });
      skipped += 1;
      continue;
    }

    try {
      const buffer = await downloadFile(accessToken, file.id, MAX_UPLOAD_BYTES, deps?.fetchImpl);
      const outcome = await dispatchDriveFile({
        orgId,
        createdBy: claimed.created_by,
        purpose: claimed.purpose,
        folder: {
          ledgerAccountId: claimed.ledger_account_id,
          dateFormat: claimed.date_format,
          columnMap: claimed.column_map,
        },
        file: { buffer, originalname: name },
      });
      await recordFile(orgId, claimed.connection_id, folderRowId, file, name, outcome);
      if (outcome.status === 'IMPORTED') imported += 1;
      else skipped += 1;
    } catch (err) {
      if (err instanceof GoogleDriveError && err.code === 'TOO_LARGE') {
        await recordFile(orgId, claimed.connection_id, folderRowId, file, name, {
          status: 'SKIPPED',
          reason: 'File exceeds the 10 MB limit',
        });
        skipped += 1;
      } else {
        // Not recorded: this file is retried on the next sync rather than
        // marked SKIPPED forever for what may be a transient failure. This
        // is also why the cursor must not advance past it below.
        lastError = err instanceof Error ? err.message : 'Unknown error';
      }
    }
  }

  // Fix C, rule 3: the cursor may only advance on a clean, COMPLETE batch.
  // `files.length < limit` means this call retrieved everything up to
  // Google's own page boundary rather than stopping early because the cap
  // was hit — a raw count at or above the cap means more could exist beyond
  // what was fetched, so advancing past it could skip a file entirely. A
  // transient per-file error has the same effect: whatever failed must be
  // retried, and retrying only works if the cursor has not already moved
  // past it.
  const canAdvance = files.length < INTEGRATION_DRIVE_MAX_FILES_PER_SYNC && lastError === null;
  const nextCursor = canAdvance ? nextCursorFrom(files) : null;

  await pool.query(
    `UPDATE integration_drive_folders
        SET drive_cursor = COALESCE($3, drive_cursor),
            last_sync_error = $4
      WHERE org_id = $1 AND id = $2`,
    [orgId, folderRowId, nextCursor, lastError === null ? null : lastError.slice(0, REASON_MAX_CHARS)],
  );

  return { imported, skipped };
}
