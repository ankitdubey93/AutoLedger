import { Pool } from 'pg';
import { env } from '../config/env.js';

/**
 * One Pool for the whole process. A PostgreSQL connection is a forked backend
 * process on the server, so connections are expensive and finite — the pool
 * exists to keep a small set of them warm and reused, not to open one per
 * request. See study/postgresql/transactions-isolation-pooling.md.
 */
export const pool = new Pool({
  host: env.PG_HOST,
  port: env.PG_PORT,
  user: env.PG_USER,
  password: env.PG_PASSWORD,
  database: env.PG_DATABASE,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

/**
 * Without this listener an error on an *idle* pooled client (network drop,
 * server restart, idle timeout enforced by PostgreSQL) is an unhandled 'error'
 * event on an EventEmitter, which crashes the process. The pool discards the
 * broken client on its own; all we owe it is a handler.
 */
pool.on('error', (err: Error) => {
  console.error('[db] idle client error — client discarded from pool:', err.message);
});

export async function closePool(): Promise<void> {
  await pool.end();
}
