import type { PoolClient } from 'pg';
import { pool } from './connect.js';
import { getRequestContext } from '../utils/requestContext.js';

/** Anything that can run a query — a pooled client, or the pool itself. */
type Queryable = Pick<PoolClient, 'query'>;

/**
 * Publishes the current request's actor and IP as transaction-local session
 * variables, for `audit_row_change()` (migration 017) to read back with
 * `current_setting(key, true)`.
 *
 * `set_config(name, value, is_local)` is used rather than `SET LOCAL
 * app.current_user_id = ...` because `SET` takes a literal, not a bind
 * parameter — the function form is the only way to do this without
 * interpolating a value into SQL, which guardrails rule 4 forbids outright.
 *
 * The third argument, `true`, is `is_local`: the setting is discarded at
 * `COMMIT` or `ROLLBACK`. Pooled connections are shared across requests, so
 * a session-level `set_config(..., false)` would leak one request's actor
 * into the next request that happened to draw the same client.
 *
 * `''` rather than `NULL` for a missing actor: `set_config` does not accept
 * a SQL `NULL` for its value, and `current_setting(..., true)` already
 * returns `''` for an unset key — the trigger's own `NULLIF(..., '')`
 * handles both cases identically.
 */
export async function applyAuditContext(client: Queryable): Promise<void> {
  const ctx = getRequestContext();
  await client.query(
    "SELECT set_config('app.current_user_id', $1, true), set_config('app.client_ip', $2, true)",
    [ctx?.userId ?? '', ctx?.ip ?? ''],
  );
}

/**
 * `BEGIN` plus `applyAuditContext`. Replaces every bare
 * `client.query('BEGIN')` in the codebase so the audit context is published
 * on every transaction without each service having to remember to do it.
 */
export async function beginTransaction(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  await applyAuditContext(client);
}

/**
 * `connect` -> `beginTransaction` -> `fn` -> `COMMIT`, with `ROLLBACK` and
 * `release` on any throw — the same shape every hand-rolled transaction in
 * this codebase already follows (see `journalService.createEntry`), factored
 * out for the single-statement writes that did not previously open one.
 *
 * Deliberately does no error mapping: it re-throws whatever `fn` or the
 * commit raised, untouched. Each caller keeps its own `catch` for mapping a
 * Postgres error code (e.g. `23505`) to an `ApiError` — that mapping is
 * call-site-specific and does not belong in a generic transaction helper.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
