import * as recurringService from '../../services/accounting/recurringService.js';
import { enqueue } from '../queues.js';
import { RECURRING_SWEEP_INTERVAL_MS } from '../../config/constants.js';
import type { JobPayloads } from '../../types/jobs.js';

/**
 * Runs every RECURRING_SWEEP_INTERVAL_MS (worker.ts's job scheduler).
 * Enqueues one generate job per schedule due for execution — the actual
 * generation work happens in recurringGenerateHandler, kept separate so
 * a slow or failing generation for one schedule never delays another org's sweep.
 *
 * The time-bucketed jobId makes a double sweep inside the same interval a
 * no-op: `enqueue`'s jobId dedup (queue/queues.ts) silently drops the
 * second `add` for the same bucket. `recurringService.listDueSchedules`
 * itself also filters on `next_run_date`, so this bucket is now a second,
 * belt-and-braces guard rather than the only one.
 */
export async function handleRecurringSweep(
  _payload: JobPayloads['recurring-sweep'],
): Promise<void> {
  const due = await recurringService.listDueSchedules();
  const bucket = Math.floor(Date.now() / RECURRING_SWEEP_INTERVAL_MS);

  for (const { orgId, scheduleId } of due) {
    await enqueue(
      'recurring-generate',
      { orgId, scheduleId },
      { jobId: `recurring-generate-${scheduleId}-${String(bucket)}` },
    );
  }
}
