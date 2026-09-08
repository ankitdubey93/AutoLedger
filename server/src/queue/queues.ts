import { Queue } from 'bullmq';
import { createRedisConnection, closeRedisConnections } from './connection.js';
import { QUEUE_NAMES, type JobPayloads, type QueueName } from '../types/jobs.js';
import { JOB_ATTEMPTS, JOB_BACKOFF_MS, JOB_KEEP_COMPLETED } from '../config/constants.js';

/**
 * One typed BullMQ Queue per name in QUEUE_NAMES, built once at import time —
 * the same module-level-singleton shape `db/connect.ts`'s `pool` follows.
 *
 * `removeOnFail: false` is load-bearing: a failed job must stay inspectable
 * (the dead-letter path and any operator debugging depend on it existing in
 * Redis after its last attempt), unlike `removeOnComplete`, which is capped
 * because a succeeded job has nothing left to say.
 */
export const queues = Object.fromEntries(
  QUEUE_NAMES.map((name) => [
    name,
    new Queue(name, {
      connection: createRedisConnection(),
      defaultJobOptions: {
        attempts: JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: JOB_BACKOFF_MS },
        removeOnComplete: JOB_KEEP_COMPLETED,
        removeOnFail: false,
      },
    }),
  ]),
) as { [K in QueueName]: Queue<JobPayloads[K]> };

export async function enqueue<K extends QueueName>(
  name: K,
  payload: JobPayloads[K],
  options?: { jobId?: string; delayMs?: number; attempts?: number },
): Promise<void> {
  // `Queue`'s NameType parameter is a conditional type derived from its data
  // type, which TS cannot resolve while `K` is still generic here — this
  // cast pins every derived parameter to the concrete type the object
  // already has at runtime; it does not change what is accepted.
  const queue = queues[name] as Queue<JobPayloads[K], unknown, string, JobPayloads[K], unknown, string>;
  await queue.add(name, payload, {
    // `jobId` is the idempotency key — BullMQ silently drops a second `add`
    // with a `jobId` already present in the queue. Callers rely on this
    // (see the outbox drain handler and the stale-delivery sweep).
    ...(options?.jobId !== undefined && { jobId: options.jobId }),
    ...(options?.delayMs !== undefined && { delay: options.delayMs }),
    ...(options?.attempts !== undefined && { attempts: options.attempts }),
  });
}

export async function closeQueues(): Promise<void> {
  await Promise.all(QUEUE_NAMES.map((name) => queues[name].close()));
  await closeRedisConnections();
}
