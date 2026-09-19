// globalSetup runs before any application module is imported, so nothing has
// pulled in config/env.ts (and with it dotenv) yet — PG_USER and PG_PASSWORD
// would both be undefined. Loading it here is safe precisely because dotenv
// never overwrites an existing key, so vitest.config.ts's `env` block still
// wins for PG_DATABASE and the token secrets.
import 'dotenv/config';
import { Client } from 'pg';
import { TEST_DATABASE, TEST_MAX_WORKERS, TEST_PG_PORT } from './testDatabase.js';
import { workerDatabase, workerRedisDb } from './workerResources.js';

/**
 * Runs once before the suite: guarantees `autodb_test` exists and has the
 * current schema, then clones it into one private database per worker
 * (`autodb_test_1`, `_2`, `_3`) so integration files can run in parallel
 * without truncating each other's fixtures. `autodb_test` itself is now a
 * TEMPLATE only — no test worker ever connects to it directly.
 *
 * Doing this in code rather than in a README step means a fresh checkout runs
 * `npm test` and it simply works — and that the schema under test is always
 * the one the migrations produce, never one that drifted by hand.
 */
export default async function setup(): Promise<void> {
  // NOT process.env.PG_DATABASE: vitest.config.ts's `env` block is applied to
  // test workers, not to this process, so that variable still says `autodb`
  // here. Reading it would migrate — and let the suite truncate — the
  // development database.
  const database = TEST_DATABASE;

  // The dynamic imports below build their pool from env at import time, so the
  // overrides have to happen before them.
  process.env.PG_DATABASE = database;

  // Same trap as PG_DATABASE, one level down: `.env` points at the DEV cluster
  // on 5432, and vitest.config.ts's `env` block never reaches this process.
  // Without this, globalSetup would migrate the template into the dev cluster
  // while the workers ran against the test one.
  process.env.PG_PORT = TEST_PG_PORT;

  /**
   * Without this, a Postgres whose port is open but which never accepts
   * (a dead container behind a stale docker-proxy socket, a paused VM)
   * hangs globalSetup forever: pg's default connect timeout is unlimited.
   * The friendly error below only fires on ECONNREFUSED, so the one
   * failure mode that actually happens produced a silent 30-minute stall.
   */
  const ADMIN_CONNECT_TIMEOUT_MS = 5000;

  // CREATE DATABASE cannot run inside a transaction block, and it cannot be
  // issued while connected to the database being created — so this is a plain
  // Client pointed at the `postgres` maintenance database, not the app's pool.
  const admin = new Client({
    host: process.env.PG_HOST ?? 'localhost',
    port: Number(process.env.PG_PORT ?? 5432),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: 'postgres',
    connectionTimeoutMillis: ADMIN_CONNECT_TIMEOUT_MS,
  });

  try {
    await admin.connect();
  } catch (err) {
    // Release the socket, or Vitest hangs for 10s on shutdown reporting a
    // "something prevents Vite server from exiting" that hides the real cause.
    await admin.end().catch(() => undefined);
    throw new Error(
      'Could not reach PostgreSQL for the integration tests. Start it with ' +
        '`docker compose up -d postgres`.\n  ' +
        'If the port is open but this timed out, the container is not accepting connections — restart it.\n  ' +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      database,
    ]);
    if (rowCount === 0) {
      // The identifier cannot be parameterised, so it is quoted rather than
      // interpolated raw — the same rule as guardrails 4, applied to DDL.
      await admin.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
      console.log(`[test] created database ${database}`);
    }
  } finally {
    await admin.end();
  }

  // Imported only now: connect.ts builds its pool at import time from env, and
  // the pool must point at the database we just made sure exists.
  const { runMigrations } = await import('../../db/migrate.js');
  const { closePool } = await import('../../db/connect.js');

  const { applied } = await runMigrations();
  if (applied.length > 0) console.log(`[test] applied ${applied.length} migration(s)`);

  // The suite's own workers open their own pools; this one has done its job.
  await closePool();

  // Each worker owns a private clone of the template so integration files
  // can run in parallel (Slice 2 of plans/test-suite-performance.md) without
  // truncating each other's fixtures. DROP + CREATE runs every setup, never
  // skipped: cloning is a file-level copy and costs far less than re-running
  // 56 migrations per database, and drop-then-create means a new migration
  // can never leave a stale clone behind. `WITH (FORCE)` needs PostgreSQL
  // 13+; the image is `pgvector/pgvector:pg16`, so it is available.
  const clone = new Client({
    host: process.env.PG_HOST ?? 'localhost',
    port: Number(process.env.PG_PORT ?? 5432),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: 'postgres',
    connectionTimeoutMillis: ADMIN_CONNECT_TIMEOUT_MS,
  });
  await clone.connect();
  try {
    for (let index = 1; index <= TEST_MAX_WORKERS; index += 1) {
      // Identifiers cannot be parameterised, so they are quoted rather than
      // interpolated raw — the same rule as guardrails 4, applied to DDL.
      const name = workerDatabase(index).replace(/"/g, '""');
      const template = database.replace(/"/g, '""');
      await clone.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await clone.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
    }
  } finally {
    await clone.end();
  }
  console.log(`[test] prepared ${TEST_MAX_WORKERS} worker database(s) from template ${TEST_DATABASE}`);

  // vitest.config.ts's `env` block does not reach this process (same trap as
  // PG_DATABASE above), so pin the index explicitly here too. One flush per
  // worker's own Redis db, mirroring the database clone loop above.
  const { Redis } = await import('ioredis');
  for (let index = 1; index <= TEST_MAX_WORKERS; index += 1) {
    const redis = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      db: workerRedisDb(index),
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      connectTimeout: ADMIN_CONNECT_TIMEOUT_MS,
    });
    try {
      await redis.connect();
      await redis.flushdb();
    } catch (err) {
      await redis.quit().catch(() => undefined);
      throw new Error(
        'Could not reach Redis for the queue tests. Start it with ' +
          `\`docker compose up -d redis\`.\n  ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await redis.quit();
  }
}
