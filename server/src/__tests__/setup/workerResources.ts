/**
 * Derives every per-worker resource name from the Vitest worker index.
 *
 * This file must import nothing. It is loaded (via perWorkerEnv.ts, a
 * `setupFiles` entry) before config/env.ts — which resolves PG_DATABASE,
 * REDIS_DB and STORAGE_ROOT at import time (env.ts:114, 121, 126) — so
 * anything imported here that transitively reaches env.ts would evaluate it
 * against the pre-override values and silently put every worker back on one
 * shared database.
 */

/**
 * VITEST_POOL_ID, never VITEST_WORKER_ID. Vitest 4.1.10 documents the pool id
 * as "between 1-`maxWorkers`" (cli-api chunk, PoolTask) — a bounded slot that
 * is reused as workers are recycled. VITEST_WORKER_ID is a different, per-task
 * counter (init chunk reassigns it from `context.workerId`) that keeps growing
 * across isolated test files, so it produced indices like 40 and pointed
 * workers at databases (`autodb_test_40`) that globalSetup never created.
 * The fallback to `1` keeps a run with no pool id set correct.
 */
const raw = process.env.VITEST_POOL_ID ?? '1';
const parsed = Number.parseInt(raw, 10);
export const WORKER_INDEX = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;

export function workerDatabase(index: number = WORKER_INDEX): string {
  return `autodb_test_${index}`;
}

export function workerRedisDb(index: number = WORKER_INDEX): number {
  return index;
}

export function workerStorageRoot(index: number = WORKER_INDEX): string {
  return `storage-test-${index}`;
}
