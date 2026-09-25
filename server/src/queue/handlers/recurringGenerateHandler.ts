import * as recurringService from '../../services/accounting/recurringService.js';
import type { JobPayloads } from '../../types/jobs.js';

/**
 * Generates a single recurring occurrence. Runs for each due schedule
 * enqueued by recurringSweepHandler.
 */
export async function handleRecurringGenerate(payload: JobPayloads['recurring-generate']): Promise<void> {
  await recurringService.runDueOccurrences(payload.orgId, payload.scheduleId);
}
