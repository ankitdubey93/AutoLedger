import { Pool, types } from 'pg';
import { env } from '../config/env.js';

/**
 * PostgreSQL `DATE` (OID 1082) is returned as a plain string, not a JS `Date`.
 *
 * By default `pg` parses it into a `Date` at **local** midnight. Calling
 * `.toISOString()` on that then converts to UTC, so in any timezone east of UTC
 * an `entry_date` of 2026-08-15 comes back as "2026-08-14" — the accounting
 * date silently moves to the previous day, and in a timezone west of UTC it
 * would move forward instead. A test caught this on the very first journal
 * entry posted; in production it would have been a period-end reporting bug
 * that appears for some users and not others.
 *
 * The deeper point is that a `DATE` has no time and no timezone. Representing
 * it as an instant is lossy by definition, and there is no timezone in which
 * the conversion is meaningful. Keeping it a string is not a workaround.
 *
 * `TIMESTAMPTZ` is unaffected and still parses to a `Date`, correctly — it
 * genuinely is an instant.
 */
types.setTypeParser(types.builtins.DATE, (value: string) => value);

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
