import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { beginTransaction } from '../../db/transaction.js';

/**
 * The database as the guardrail, not the service — raw SQL straight at the
 * pool proves migration 033's constraints hold regardless of what wrote the
 * row. Unlike ap_flow_documents (migration 032) and posted financial
 * documents generally, fpa_models/fpa_scenarios carry NO immutability
 * trigger — nothing here posts to the GL, so rule 6 does not apply. Case 6
 * below proves that absence is deliberate, not an oversight.
 */

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';

async function errorCode(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err) {
      return typeof err.code === 'string' ? err.code : undefined;
    }
  }
  return undefined;
}

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;

async function seedModel(orgId: string, createdBy: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO fpa_models (org_id, name, starts_on, horizon_months, actuals_through, created_by)
     VALUES ($1, 'Test Model', '2026-10-01', 12, '2026-09-01', $2)
     RETURNING id`,
    [orgId, createdBy],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('fixture: no fpa_models id');
  return id;
}

describe('fpa-engine database constraints', () => {
  beforeEach(async () => {
    await resetTables();
    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;
    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
    orgB = userB.orgId;
  });

  afterAll(closePool);

  it('1. rejects a mid-month starts_on with 23514', async () => {
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO fpa_models (org_id, name, starts_on, horizon_months, actuals_through, created_by)
         VALUES ($1, 'Bad', '2026-10-15', 12, '2026-09-01', $2)`,
        [orgA, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('2. rejects actuals_through >= starts_on with 23514', async () => {
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO fpa_models (org_id, name, starts_on, horizon_months, actuals_through, created_by)
         VALUES ($1, 'Bad', '2026-10-01', 12, '2026-10-01', $2)`,
        [orgA, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('3. rejects horizon_months = 0 with 23514', async () => {
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO fpa_models (org_id, name, starts_on, horizon_months, actuals_through, created_by)
         VALUES ($1, 'Bad', '2026-10-01', 0, '2026-09-01', $2)`,
        [orgA, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('4. rejects a cross-tenant fpa_scenarios parent with 23503', async () => {
    const modelIdOrgA = await seedModel(orgA, userA.id);

    // Correct org_id (orgB) but a model_id that belongs to orgA — the
    // composite FK (org_id, model_id) -> fpa_models (org_id, id) must make
    // this cross-tenant parent unrepresentable.
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO fpa_scenarios (org_id, model_id, name, kind, is_default)
         VALUES ($1, $2, 'Base', 'BASE', true)`,
        [orgB, modelIdOrgA],
      ),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('5. rejects a second default scenario on the same model with 23505', async () => {
    const modelId = await seedModel(orgA, userA.id);
    await pool.query(
      `INSERT INTO fpa_scenarios (org_id, model_id, name, kind, is_default) VALUES ($1, $2, 'Base', 'BASE', true)`,
      [orgA, modelId],
    );

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO fpa_scenarios (org_id, model_id, name, kind, is_default) VALUES ($1, $2, 'Upside', 'UPSIDE', true)`,
        [orgA, modelId],
      ),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('6. allows an in-place UPDATE — no immutability trigger, deliberately', async () => {
    const modelId = await seedModel(orgA, userA.id);

    const before = await pool.query<{ updated_at: Date }>('SELECT updated_at FROM fpa_models WHERE id = $1', [
      modelId,
    ]);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const code = await errorCode(() =>
      pool.query(`UPDATE fpa_models SET name = 'Renamed' WHERE id = $1`, [modelId]),
    );
    expect(code).toBeUndefined();

    const after = await pool.query<{ name: string; updated_at: Date }>(
      'SELECT name, updated_at FROM fpa_models WHERE id = $1',
      [modelId],
    );
    expect(after.rows[0]?.name).toBe('Renamed');
    expect(after.rows[0]?.updated_at.getTime()).toBeGreaterThan(before.rows[0]?.updated_at.getTime() ?? 0);
  });

  it('7. audit_row_change tags fpa_models rows with app_slug fpa-engine', async () => {
    const client = await pool.connect();
    try {
      await beginTransaction(client);
      await client.query(
        `INSERT INTO fpa_models (org_id, name, starts_on, horizon_months, actuals_through, created_by)
         VALUES ($1, 'Audited Model', '2026-10-01', 12, '2026-09-01', $2)`,
        [orgA, userA.id],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const { rows } = await pool.query<{ app_slug: string }>(
      `SELECT app_slug FROM audit_logs WHERE table_name = 'fpa_models' AND org_id = $1 ORDER BY id DESC LIMIT 1`,
      [orgA],
    );
    expect(rows[0]?.app_slug).toBe('fpa-engine');
  });
});
