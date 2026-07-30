import { pool } from '../db/connect.js';

export interface DatabaseHealth {
  connected: boolean;
  latencyMs: number | null;
  error?: string;
}

/**
 * The only SQL in the health path, and it lives here because every query in
 * this codebase lives in a service — docs/guardrails.md rule 2.
 *
 * `SELECT 1` proves more than a TCP connect: it takes a client out of the pool,
 * completes a full round trip through the wire protocol, and returns it. A
 * reachable port with an unauthenticated or read-blocked database fails here.
 *
 * No org_id predicate applies — this touches no tenant data.
 */
export async function checkDatabase(): Promise<DatabaseHealth> {
  const startedAt = performance.now();
  try {
    await pool.query('SELECT 1');
    return { connected: true, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (err) {
    return {
      connected: false,
      latencyMs: null,
      error: err instanceof Error ? err.message : 'Unknown database error',
    };
  }
}
