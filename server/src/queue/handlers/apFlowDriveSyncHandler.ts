import * as driveConnectionService from '../../services/ap-flow/driveConnectionService.js';
import type { DriveServiceDeps } from '../../services/ap-flow/driveConnectionService.js';
import type { JobPayloads } from '../../types/jobs.js';

/**
 * One connection's sync run — Drive's own extraction/classification/
 * metering happens downstream, inside apFlowDocumentService.captureFile's
 * own enqueue of 'ap-flow-extract' (Phase 19.1's meter picks it up there
 * with no extra work: entityId is the imported document's own id).
 */
export async function handleApFlowDriveSync(
  payload: JobPayloads['ap-flow-drive-sync'],
  deps?: DriveServiceDeps,
): Promise<void> {
  await driveConnectionService.syncConnection(payload.orgId, payload.connectionId, deps);
}
