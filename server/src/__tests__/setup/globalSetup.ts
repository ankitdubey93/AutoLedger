// globalSetup runs before any application module is imported, so nothing has
// pulled in config/env.ts (and with it dotenv) yet — PG_USER and PG_PASSWORD
// would both be undefined. Loading it here is safe precisely because dotenv
// never overwrites an existing key, so vitest.config.ts's `env` block still
// wins for PG_DATABASE and the token secrets.
import 'dotenv/config';
import { Client } from 'pg';
import { TEST_DATABASE } from './testDatabase.js';

/**
 * Runs once before the suite: guarantees `autodb_test` exists and has the
 * current schema.
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
  // override has to happen before them.
  process.env.PG_DATABASE = database;

  // CREATE DATABASE cannot run inside a transaction block, and it cannot be
  // issued while connected to the database being created — so this is a plain
  // Client pointed at the `postgres` maintenance database, not the app's pool.
  const admin = new Client({
    host: process.env.PG_HOST ?? 'localhost',
    port: Number(process.env.PG_PORT ?? 5432),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: 'postgres',
  });

  try {
    await admin.connect();
  } catch (err) {
    // Release the socket, or Vitest hangs for 10s on shutdown reporting a
    // "something prevents Vite server from exiting" that hides the real cause.
    await admin.end().catch(() => undefined);
    throw new Error(
      'Could not reach PostgreSQL for the integration tests. Start it with ' +
        `\`docker compose up -d postgres\`.\n  ${err instanceof Error ? err.message : String(err)}`,
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

  // vitest.config.ts's `env` block does not reach this process (same trap as
  // PG_DATABASE above), so pin the index explicitly here too.
  const { Redis } = await import('ioredis');
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    db: 1,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
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
