/**
 * A `setupFiles` entry, which Vitest evaluates in the worker BEFORE it
 * imports the test file — and therefore before anything imports
 * config/env.ts, which resolves these three at import time (env.ts:114,
 * 121, 126). Writing them here is what gives each worker its own database,
 * Redis index and storage directory.
 *
 * Imports only ./workerResources.js, which itself imports nothing. Any
 * import here that transitively reaches config/env.ts would evaluate it
 * against the pre-override values and silently put every worker back on
 * one database.
 */
import { TEST_PG_PORT } from './testDatabase.js';
import { workerDatabase, workerRedisDb, workerStorageRoot } from './workerResources.js';

// The `postgres-test` cluster (fsync=off), never the dev one on 5432.
process.env.PG_PORT = TEST_PG_PORT;
process.env.PG_DATABASE = workerDatabase();
process.env.REDIS_DB = String(workerRedisDb());
process.env.STORAGE_ROOT = workerStorageRoot();
