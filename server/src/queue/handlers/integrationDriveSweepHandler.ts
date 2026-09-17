import * as driveSyncService from '../../services/integrations/driveSyncService.js';
import { enqueue } from '../queues.js';
import { INTEGRATION_DRIVE_POLL_INTERVAL_MS } from '../../config/constants.js';
import type { JobPayloads } from '../../types/jobs.js';

/**
 * Runs every INTEGRATION_DRIVE_POLL_INTERVAL_MS (worker.ts's job scheduler).
 * Enqueues one sync job per folder due for a check — the actual sync work
 * happens in integrationDriveSyncHandler, kept separate so a slow or
 * failing sync for one folder never delays another org's sweep.
 *
 * The time-bucketed jobId makes a double sweep inside the same interval a
 * no-op: `enqueue`'s jobId dedup (queue/queues.ts) silently drops the
 * second `add` for the same bucket. `driveSyncService.listFoldersDueForSync`
 * itself also filters on `last_synced_at`, so this bucket is now a second,
 * belt-and-braces guard rather than the only one.
 */
export async function handleIntegrationDriveSweep(
  _payload: JobPayloads['integration-drive-sweep'],
): Promise<void> {
  const due = await driveSyncService.listFoldersDueForSync();
  const bucket = Math.floor(Date.now() / INTEGRATION_DRIVE_POLL_INTERVAL_MS);

  for (const { orgId, folderId } of due) {
    await enqueue(
      'integration-drive-sync',
      { orgId, folderId },
      { jobId: `integration-drive-sync-${folderId}-${String(bucket)}` },
    );
  }
}
