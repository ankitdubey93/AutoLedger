import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * The database as the guardrail, not the service — raw SQL straight at the
 * pool proves migrations 040-041's constraints hold regardless of what
 * wrote the row. Mirrors `forecaster/forecasterConstraints.test.ts`'s
 * posture.
 */

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

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

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code}`);
  return row.id;
}

describe('unitecon database constraints', () => {
  beforeEach(async () => {
    await resetTables();
    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;
    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
    orgB = userB.orgId;
  });

  afterAll(closePool);

  it('1. rejects gross_margin_bps above 10000', async () => {
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO unitecon_settings (org_id, gross_margin_bps, created_by) VALUES ($1, 10001, $2)`,
        [orgA, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('2. rejects a negative gross_margin_bps', async () => {
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO unitecon_settings (org_id, gross_margin_bps, created_by) VALUES ($1, -1, $2)`,
        [orgA, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('3. rejects a duplicate (org_id, account_id) in unitecon_acquisition_accounts', async () => {
    const expenseId = await accountId(orgA, '6100');
    await pool.query('INSERT INTO unitecon_acquisition_accounts (org_id, account_id) VALUES ($1, $2)', [
      orgA,
      expenseId,
    ]);

    const code = await errorCode(() =>
      pool.query('INSERT INTO unitecon_acquisition_accounts (org_id, account_id) VALUES ($1, $2)', [
        orgA,
        expenseId,
      ]),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('4. the same account_id under two different orgs both succeed (org-scoped uniqueness)', async () => {
    const expenseIdA = await accountId(orgA, '6100');
    const expenseIdB = await accountId(orgB, '6100');

    await pool.query('INSERT INTO unitecon_acquisition_accounts (org_id, account_id) VALUES ($1, $2)', [
      orgA,
      expenseIdA,
    ]);
    await pool.query('INSERT INTO unitecon_acquisition_accounts (org_id, account_id) VALUES ($1, $2)', [
      orgB,
      expenseIdB,
    ]);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM unitecon_acquisition_accounts',
    );
    expect(rows[0]?.count).toBe('2');
  });

  it('5. rejects a blank product-line name', async () => {
    const revenueId = await accountId(orgA, '4100');
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO unitecon_product_lines (org_id, revenue_account_id, name, created_by)
         VALUES ($1, $2, '   ', $3)`,
        [orgA, revenueId, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('6. rejects a unit_label over 40 characters', async () => {
    const revenueId = await accountId(orgA, '4100');
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO unitecon_product_lines (org_id, revenue_account_id, name, unit_label, created_by)
         VALUES ($1, $2, 'Widgets', $3, $4)`,
        [orgA, revenueId, 'x'.repeat(41), userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('7. rejects two product lines on the same (org_id, revenue_account_id)', async () => {
    const revenueId = await accountId(orgA, '4100');
    await pool.query(
      `INSERT INTO unitecon_product_lines (org_id, revenue_account_id, name, created_by)
       VALUES ($1, $2, 'Widgets', $3)`,
      [orgA, revenueId, userA.id],
    );

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO unitecon_product_lines (org_id, revenue_account_id, name, created_by)
         VALUES ($1, $2, 'Widgets 2', $3)`,
        [orgA, revenueId, userA.id],
      ),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('8. rejects two product lines with the same (org_id, name)', async () => {
    const revenueId4100 = await accountId(orgA, '4100');
    const revenueId4200 = await accountId(orgA, '4200');
    await pool.query(
      `INSERT INTO unitecon_product_lines (org_id, revenue_account_id, name, created_by)
       VALUES ($1, $2, 'Widgets', $3)`,
      [orgA, revenueId4100, userA.id],
    );

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO unitecon_product_lines (org_id, revenue_account_id, name, created_by)
         VALUES ($1, $2, 'Widgets', $3)`,
        [orgA, revenueId4200, userA.id],
      ),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('9. deleting the organization cascades all three unitecon_* tables to zero rows', async () => {
    const revenueId = await accountId(orgA, '4100');
    const expenseId = await accountId(orgA, '6100');

    await pool.query('INSERT INTO unitecon_settings (org_id, gross_margin_bps, created_by) VALUES ($1, 6000, $2)', [
      orgA,
      userA.id,
    ]);
    await pool.query('INSERT INTO unitecon_acquisition_accounts (org_id, account_id) VALUES ($1, $2)', [
      orgA,
      expenseId,
    ]);
    await pool.query(
      `INSERT INTO unitecon_product_lines (org_id, revenue_account_id, name, created_by)
       VALUES ($1, $2, 'Widgets', $3)`,
      [orgA, revenueId, userA.id],
    );

    await pool.query('DELETE FROM organizations WHERE id = $1', [orgA]);

    const settings = await pool.query('SELECT COUNT(*)::int AS count FROM unitecon_settings WHERE org_id = $1', [
      orgA,
    ]);
    const acquisition = await pool.query(
      'SELECT COUNT(*)::int AS count FROM unitecon_acquisition_accounts WHERE org_id = $1',
      [orgA],
    );
    const productLines = await pool.query(
      'SELECT COUNT(*)::int AS count FROM unitecon_product_lines WHERE org_id = $1',
      [orgA],
    );

    expect(settings.rows[0]?.count).toBe(0);
    expect(acquisition.rows[0]?.count).toBe(0);
    expect(productLines.rows[0]?.count).toBe(0);
  });

  it('10. UPDATE on unitecon_product_lines succeeds — no immutability trigger, by design (D6)', async () => {
    const revenueId = await accountId(orgA, '4100');
    const { rows } = await pool.query<{ id: string; updated_at: Date }>(
      `INSERT INTO unitecon_product_lines (org_id, revenue_account_id, name, created_by)
       VALUES ($1, $2, 'Widgets', $3)
       RETURNING id, updated_at`,
      [orgA, revenueId, userA.id],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('fixture: no product line id');

    await new Promise((resolve) => setTimeout(resolve, 10));

    const updated = await pool.query<{ updated_at: Date }>(
      `UPDATE unitecon_product_lines SET name = 'Widgets v2' WHERE id = $1 RETURNING updated_at`,
      [row.id],
    );
    const newUpdatedAt = updated.rows[0]?.updated_at;
    expect(newUpdatedAt).toBeDefined();
    expect(newUpdatedAt?.getTime()).toBeGreaterThan(row.updated_at.getTime());
  });

  it('11. an INSERT into unitecon_product_lines writes an audit_logs row tagged unitecon', async () => {
    const revenueId = await accountId(orgA, '4100');
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO unitecon_product_lines (org_id, revenue_account_id, name, created_by)
       VALUES ($1, $2, 'Widgets', $3)
       RETURNING id`,
      [orgA, revenueId, userA.id],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('fixture: no product line id');

    const { rows: auditRows } = await pool.query<{ app_slug: string }>(
      `SELECT app_slug FROM audit_logs
        WHERE table_name = 'unitecon_product_lines' AND operation = 'INSERT' AND row_id = $1`,
      [id],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.app_slug).toBe('unitecon');
  });
});
