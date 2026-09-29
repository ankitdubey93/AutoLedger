import { env } from './config/env.js';
import { closePool } from './db/connect.js';
import { startWorkers, stopWorkers } from './queue/worker.js';
import { QUEUE_NAMES } from './types/jobs.js';
import { SHUTDOWN_TIMEOUT_MS } from './config/constants.js';
import { logger } from './utils/logger.js';

/**
 * Background-job process entry point. A second process, sharing the same
 * src/ as the API server (src/index.ts), consuming the queues that server
 * writes to. Lifecycle discipline mirrors index.ts: same shutdown latch,
 * same unref'd force-exit timer, same process-level listeners.
 */

logger.info(
  `[worker] ${env.NODE_ENV} — consuming ${QUEUE_NAMES.length - 1} queue(s) on ` +
    `${env.REDIS_HOST}:${String(env.REDIS_PORT)}/${String(env.REDIS_DB)}`,
);

await startWorkers();

let shuttingDown = false;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`[worker] ${signal} received — draining`);

  const forceExit = setTimeout(() => {
    logger.error(`[worker] drain exceeded ${String(SHUTDOWN_TIMEOUT_MS)}ms — forcing exit`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    await stopWorkers();
    await closePool();
    logger.info('[worker] shutdown complete');
    process.exit(exitCode);
  } catch (err) {
    logger.error({ err }, '[worker] shutdown failed');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, '[worker] unhandled promise rejection');
  void shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, '[worker] uncaught exception');
  void shutdown('uncaughtException', 1);
});
