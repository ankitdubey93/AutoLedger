import * as driveConnectionService from '../../services/ap-flow/driveConnectionService.js';
import { enqueue } from '../queues.js';
import { AP_FLOW_DRIVE_POLL_INTERVAL_MS } from '../../config/constants.js';
import type { JobPayloads } from '../../types/jobs.js';

/**
 * Runs every AP_FLOW_DRIVE_POLL_INTERVAL_MS (worker.ts's job scheduler).
 * Enqueues one sync job per connection due for a check — the actual sync
 * work happens in apFlowDriveSyncHandler, kept separate so a slow or
 * failing sync for one org never delays another org's sweep.
 *
 * The time-bucketed jobId makes a double sweep inside the same interval a
 * no-op: `enqueue`'s jobId dedup (queue/queues.ts) silently drops the
 * second `add` for the same bucket.
 */
export async function handleApFlowDriveSweep(
  _payload: JobPayloads['ap-flow-drive-sweep'],
): Promise<void> {
  const due = await driveConnectionService.listConnectionsDueForSync();
  const bucket = Math.floor(Date.now() / AP_FLOW_DRIVE_POLL_INTERVAL_MS);

  for (const { orgId, connectionId } of due) {
    await enqueue(
      'ap-flow-drive-sync',
      { orgId, connectionId },
      { jobId: `ap-flow-drive-sync-${connectionId}-${String(bucket)}` },
    );
  }
}
