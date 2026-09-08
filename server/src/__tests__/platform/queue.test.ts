import { Worker } from 'bullmq';
import { enqueue, queues, closeQueues } from '../../queue/queues.js';
import { createRedisConnection } from '../../queue/connection.js';
import { isQueueName, QUEUE_NAMES } from '../../types/jobs.js';

/**
 * Integration tier — requires the real Redis container
 * (`docker compose up -d redis`). No mock: the point of these cases is that
 * BullMQ's retry/backoff/dead-letter machinery actually behaves as the
 * worker relies on it to.
 */
describe('background job queue', () => {
  afterEach(async () => {
    await Promise.all(QUEUE_NAMES.map((name) => queues[name].obliterate({ force: true })));
  });

  afterAll(async () => {
    await closeQueues();
  });

  it('isQueueName narrows known and rejects unknown queue names', () => {
    expect(isQueueName('outbox-drain')).toBe(true);
    expect(isQueueName('nope')).toBe(false);
  });

  it('a job processed by a worker resolves the handler', async () => {
    let calls = 0;
    const worker = new Worker(
      'integrity-check',
      async () => {
        calls += 1;
      },
      { connection: createRedisConnection(), concurrency: 1 },
    );

    const completed = new Promise<void>((resolve) => {
      worker.on('completed', () => resolve());
    });

    await enqueue('integrity-check', {});
    await completed;
    await worker.close();

    expect(calls).toBe(1);
  });

  it('a job that always throws is retried JOB_ATTEMPTS times and then dead-lettered', async () => {
    // Mirrors worker.ts's onTerminalFailure: a 'failed' listener that
    // enqueues to the dead-letter queue only once every retry is spent.
    let attempts = 0;
    const worker = new Worker(
      'integrity-check',
      async () => {
        attempts += 1;
        throw new Error('always fails');
      },
      { connection: createRedisConnection(), concurrency: 1 },
    );

    const terminal = new Promise<void>((resolve) => {
      worker.on('failed', (job, err) => {
        if (job === undefined) return;
        const configuredAttempts = job.opts.attempts ?? 2;
        if (job.attemptsMade < configuredAttempts) return;
        void enqueue('dead-letter', {
          queue: 'integrity-check',
          jobId: job.id ?? 'unknown',
          failedReason: err.message,
          payload: job.data as unknown,
        }).then(resolve);
      });
    });

    await enqueue('integrity-check', {});
    await terminal;
    await worker.close();

    expect(attempts).toBe(2);
    const dlqCount = await queues['dead-letter'].getWaitingCount();
    expect(dlqCount).toBe(1);
  });

  it('enqueue with the same jobId twice adds only one job', async () => {
    await enqueue('outbox-drain', {}, { jobId: 'dedupe-test' });
    await enqueue('outbox-drain', {}, { jobId: 'dedupe-test' });

    const count = await queues['outbox-drain'].getWaitingCount();
    expect(count).toBe(1);
  });
});
