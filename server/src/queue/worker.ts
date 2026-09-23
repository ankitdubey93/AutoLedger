import { Queue, Worker, type Job } from 'bullmq';
import { createRedisConnection } from './connection.js';
import { enqueue, closeQueues, queues } from './queues.js';
import { handleIntegrityCheck } from './handlers/integrityCheckHandler.js';
import { handleOutboxDrain } from './handlers/outboxDrainHandler.js';
import { handleWebhookDeliver } from './handlers/webhookDeliverHandler.js';
import { handleApFlowExtract } from './handlers/apFlowExtractHandler.js';
import { handleIntegrationDriveSweep } from './handlers/integrationDriveSweepHandler.js';
import { handleIntegrationDriveSync } from './handlers/integrationDriveSyncHandler.js';
import { markFailed } from '../services/webhookDeliveryService.js';
import {
  INTEGRATION_DRIVE_POLL_INTERVAL_MS,
  INTEGRITY_CHECK_CRON,
  JOB_ATTEMPTS,
  OUTBOX_DRAIN_INTERVAL_MS,
  WEBHOOK_ERROR_SNIPPET_CHARS,
} from '../config/constants.js';
import type { JobPayloads, QueueName } from '../types/jobs.js';

/**
 * One BullMQ Worker per queue name, except 'dead-letter' — nothing consumes
 * the graveyard; a worker on it would delete the evidence.
 */
const HANDLERS: {
  [K in Exclude<QueueName, 'dead-letter'>]: (payload: JobPayloads[K]) => Promise<void>;
} = {
  'integrity-check': handleIntegrityCheck,
  'outbox-drain': handleOutboxDrain,
  'webhook-deliver': handleWebhookDeliver,
  'ap-flow-extract': handleApFlowExtract,
  'integration-drive-sweep': handleIntegrationDriveSweep,
  'integration-drive-sync': handleIntegrationDriveSync,
};

let workers: Worker[] = [];

/**
 * Called only once a job has spent every retry BullMQ granted it — not on
 * the first failure. Moves the job to the dead-letter queue, which is
 * Phase 7's alerting channel: an operator (or a later phase's watcher)
 * inspects it, rather than the failure vanishing into a log line.
 *
 * Step C4 extends this to also mark the corresponding webhook_deliveries
 * row FAILED for the 'webhook-deliver' queue.
 */
async function onTerminalFailure(
  name: Exclude<QueueName, 'dead-letter'>,
  job: Job | undefined,
  err: Error,
): Promise<void> {
  if (job === undefined) return;
  const attempts = job.opts.attempts ?? JOB_ATTEMPTS;
  if (job.attemptsMade < attempts) return;

  try {
    // The one place a delivery moves PENDING -> FAILED — after every retry
    // has been spent, not on the first failed attempt.
    if (name === 'webhook-deliver') {
      const data = job.data as JobPayloads['webhook-deliver'];
      await markFailed(data.deliveryId, err.message.slice(0, WEBHOOK_ERROR_SNIPPET_CHARS));
    }

    await enqueue(
      'dead-letter',
      {
        queue: name,
        jobId: job.id ?? 'unknown',
        failedReason: err.message.slice(0, 500),
        payload: job.data as unknown,
      },
      { attempts: 1 },
    );
  } catch (dlqErr) {
    // A dead-letter enqueue that itself fails must never re-enter the
    // failure path — log and stop.
    console.error('[worker] failed to dead-letter a job:', dlqErr);
  }
}

export async function startWorkers(): Promise<void> {
  workers = (Object.keys(HANDLERS) as Exclude<QueueName, 'dead-letter'>[]).map((name) => {
    const worker = new Worker(
      name,
      async (job) => {
        await HANDLERS[name](job.data as never);
      },
      { connection: createRedisConnection(), concurrency: 5 },
    );
    worker.on('failed', (job, err) => {
      void onTerminalFailure(name, job, err);
    });
    return worker;
  });

  await queues['integrity-check'].upsertJobScheduler(
    'integrity-check-daily',
    { pattern: INTEGRITY_CHECK_CRON },
    { name: 'integrity-check', data: {}, opts: { attempts: 1 } },
  );

  // The drain is idempotent and re-runs in five seconds anyway, so
  // attempts: 1 — a BullMQ retry here would only stack overlapping passes.
  await queues['outbox-drain'].upsertJobScheduler(
    'outbox-drain-tick',
    { every: OUTBOX_DRAIN_INTERVAL_MS },
    { name: 'outbox-drain', data: {}, opts: { attempts: 1 } },
  );

  // Phase 19.3 — the Drive integration's poll. attempts: 1, same reasoning as
  // the outbox drain: the sweep itself is idempotent and the next tick will
  // re-check anyway.
  await queues['integration-drive-sweep'].upsertJobScheduler(
    'integration-drive-sweep-tick',
    { every: INTEGRATION_DRIVE_POLL_INTERVAL_MS },
    { name: 'integration-drive-sweep', data: {}, opts: { attempts: 1 } },
  );

  // Phase 19.3 — 19.2's scheduler lives in Redis independently of this code,
  // under the queue name Drive intake used before it moved off AP-Flow. A
  // rename of QUEUE_NAMES does not touch what is already sitting in Redis:
  // without this, 'ap-flow-drive-sweep-tick' would keep firing forever
  // against a queue no worker consumes. Removing it by id is idempotent — a
  // no-op once removed, and a no-op on a fresh Redis that never had it.
  await new Queue('ap-flow-drive-sweep', { connection: createRedisConnection() })
    .removeJobScheduler('ap-flow-drive-sweep-tick')
    .catch(() => undefined);
}

export async function stopWorkers(): Promise<void> {
  await Promise.all(workers.map((worker) => worker.close()));
  workers = [];
  await closeQueues();
}
