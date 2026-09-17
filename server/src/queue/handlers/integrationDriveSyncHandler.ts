import * as driveSyncService from '../../services/integrations/driveSyncService.js';
import type { DriveServiceDeps } from '../../services/integrations/driveConnectionService.js';
import type { JobPayloads } from '../../types/jobs.js';

/**
 * One folder's sync run. Its own extraction/classification/metering happens
 * downstream, inside apFlowDocumentService.captureFile's own enqueue of
 * 'ap-flow-extract' for VENDOR_BILL (Phase 19.1's meter picks it up there
 * with no extra work: entityId is the imported document's own id) — or
 * synchronously inside bankImportService.importStatement for BANK_STATEMENT.
 */
export async function handleIntegrationDriveSync(
  payload: JobPayloads['integration-drive-sync'],
  deps?: DriveServiceDeps,
): Promise<void> {
  await driveSyncService.syncFolder(payload.orgId, payload.folderId, deps);
}
