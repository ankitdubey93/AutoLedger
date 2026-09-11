import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * The database as the guardrail, not the service — raw SQL straight at the
 * pool proves migrations 035-039's constraints hold regardless of what
 * wrote the row. Mirrors `fpa-engine/fpaConstraints.test.ts`'s posture.
 */

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const RAISED_EXCEPTION = '0A000';

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

async function seedPlan(orgId: string, createdBy: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO forecaster_plans (org_id, name, starts_on, horizon_months, actuals_through, created_by)
     VALUES ($1, 'Test Plan', '2026-10-01', 3, '2026-09-01', $2)
     RETURNING id`,
    [orgId, createdBy],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('fixture: no forecaster_plans id');
  return id;
}

async function seedDriver(orgId: string, planId: string, kind: 'COUNT' | 'CENTS' | 'BPS', name = 'Driver'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO forecaster_drivers (org_id, plan_id, name, kind) VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, planId, name, kind],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('fixture: no forecaster_drivers id');
  return id;
}

async function seedBudgetVersion(orgId: string, planId: string, createdBy: string, label = 'Version'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO forecaster_budget_versions (org_id, plan_id, label, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, planId, label, createdBy],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('fixture: no forecaster_budget_versions id');
  return id;
}

async function seedBudgetLine(
  orgId: string,
  versionId: string,
  accountIdForLine: string,
  month = '2026-10-01',
  source: 'DRIVER' | 'HEADCOUNT' | 'MANUAL' = 'MANUAL',
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO forecaster_budget_lines (org_id, version_id, account_id, month, amount_cents, source, justification)
     VALUES ($1, $2, $3, $4::date, 1000, $5, 'Fixture line')
     RETURNING id`,
    [orgId, versionId, accountIdForLine, month, source],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('fixture: no forecaster_budget_lines id');
  return id;
}

describe('forecaster database constraints', () => {
  beforeEach(async () => {
    await resetTables();
    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;
    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
    orgB = userB.orgId;
  });

  afterAll(closePool);

  it('1. rejects a plan whose starts_on is not the first of a month', async () => {
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO forecaster_plans (org_id, name, starts_on, horizon_months, actuals_through, created_by)
         VALUES ($1, 'Bad', '2026-10-15', 12, '2026-09-01', $2)`,
        [orgA, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('2. rejects a plan whose actuals_through is not before starts_on', async () => {
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO forecaster_plans (org_id, name, starts_on, horizon_months, actuals_through, created_by)
         VALUES ($1, 'Bad', '2026-10-01', 12, '2026-10-01', $2)`,
        [orgA, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('3. rejects a duplicate plan name within one org', async () => {
    await seedPlan(orgA, userA.id);
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO forecaster_plans (org_id, name, starts_on, horizon_months, actuals_through, created_by)
         VALUES ($1, 'Test Plan', '2026-10-01', 3, '2026-09-01', $2)`,
        [orgA, userA.id],
      ),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('4. allows the same plan name in a different org', async () => {
    await seedPlan(orgA, userA.id);
    const code = await errorCode(() => seedPlan(orgB, userB.id));
    expect(code).toBeUndefined();
  });

  it('5. rejects a driver kind outside COUNT/CENTS/BPS', async () => {
    const planId = await seedPlan(orgA, userA.id);
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO forecaster_drivers (org_id, plan_id, name, kind) VALUES ($1, $2, 'Bad', 'FLOAT')`,
        [orgA, planId],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('6. rejects two values for the same driver and month', async () => {
    const planId = await seedPlan(orgA, userA.id);
    const driverId = await seedDriver(orgA, planId, 'COUNT');
    await pool.query(
      `INSERT INTO forecaster_driver_values (org_id, driver_id, month, value) VALUES ($1, $2, '2026-10-01', 5)`,
      [orgA, driverId],
    );
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO forecaster_driver_values (org_id, driver_id, month, value) VALUES ($1, $2, '2026-10-01', 9)`,
        [orgA, driverId],
      ),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('7. rejects a headcount role with a negative annual_salary_cents', async () => {
    const planId = await seedPlan(orgA, userA.id);
    const expenseId = await accountId(orgA, '6100');
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO forecaster_headcount_roles (org_id, plan_id, title, account_id, starts_on, annual_salary_cents)
         VALUES ($1, $2, 'Bad', $3, '2026-10-01', -1)`,
        [orgA, planId, expenseId],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('8. rejects a headcount role whose ends_on precedes starts_on', async () => {
    const planId = await seedPlan(orgA, userA.id);
    const expenseId = await accountId(orgA, '6100');
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO forecaster_headcount_roles (org_id, plan_id, title, account_id, starts_on, ends_on, annual_salary_cents)
         VALUES ($1, $2, 'Bad', $3, '2026-11-01', '2026-10-01', 1000)`,
        [orgA, planId, expenseId],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('9. rejects a DRIVER_PRODUCT forecast line carrying a fixed_cents', async () => {
    const planId = await seedPlan(orgA, userA.id);
    const revenueId = await accountId(orgA, '4100');
    const qtyDriverId = await seedDriver(orgA, planId, 'COUNT', 'Qty');
    const rateDriverId = await seedDriver(orgA, planId, 'CENTS', 'Rate');
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO forecaster_forecast_lines
           (org_id, plan_id, account_id, label, kind, quantity_driver_id, rate_driver_id, fixed_cents)
         VALUES ($1, $2, $3, 'Bad', 'DRIVER_PRODUCT', $4, $5, 100)`,
        [orgA, planId, revenueId, qtyDriverId, rateDriverId],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('10. rejects a FIXED_CENTS forecast line carrying a driver id', async () => {
    const planId = await seedPlan(orgA, userA.id);
    const revenueId = await accountId(orgA, '4100');
    const qtyDriverId = await seedDriver(orgA, planId, 'COUNT', 'Qty');
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO forecaster_forecast_lines
           (org_id, plan_id, account_id, label, kind, quantity_driver_id, fixed_cents)
         VALUES ($1, $2, $3, 'Bad', 'FIXED_CENTS', $4, 100)`,
        [orgA, planId, revenueId, qtyDriverId],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('11. rejects deleting a driver a forecast line references', async () => {
    const planId = await seedPlan(orgA, userA.id);
    const revenueId = await accountId(orgA, '4100');
    const qtyDriverId = await seedDriver(orgA, planId, 'COUNT', 'Qty');
    const rateDriverId = await seedDriver(orgA, planId, 'CENTS', 'Rate');
    await pool.query(
      `INSERT INTO forecaster_forecast_lines
         (org_id, plan_id, account_id, label, kind, quantity_driver_id, rate_driver_id)
       VALUES ($1, $2, $3, 'Line', 'DRIVER_PRODUCT', $4, $5)`,
      [orgA, planId, revenueId, qtyDriverId, rateDriverId],
    );
    const code = await errorCode(() =>
      pool.query('DELETE FROM forecaster_drivers WHERE org_id = $1 AND id = $2', [orgA, qtyDriverId]),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('12. rejects a cross-tenant driver on a forecast line', async () => {
    const planIdA = await seedPlan(orgA, userA.id);
    const revenueIdA = await accountId(orgA, '4100');
    const driverIdB = await seedDriver(orgB, await seedPlan(orgB, userB.id), 'COUNT', 'B Qty');
    const rateDriverIdA = await seedDriver(orgA, planIdA, 'CENTS', 'Rate');

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO forecaster_forecast_lines
           (org_id, plan_id, account_id, label, kind, quantity_driver_id, rate_driver_id)
         VALUES ($1, $2, $3, 'Cross', 'DRIVER_PRODUCT', $4, $5)`,
        [orgA, planIdA, revenueIdA, driverIdB, rateDriverIdA],
      ),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('13. rejects a blank justification on a budget line', async () => {
    const planId = await seedPlan(orgA, userA.id);
    const versionId = await seedBudgetVersion(orgA, planId, userA.id);
    const revenueId = await accountId(orgA, '4100');
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO forecaster_budget_lines (org_id, version_id, account_id, month, amount_cents, source, justification)
         VALUES ($1, $2, $3, '2026-10-01', 100, 'MANUAL', '   ')`,
        [orgA, versionId, revenueId],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('14. rejects two APPROVED versions on one plan', async () => {
    const planId = await seedPlan(orgA, userA.id);
    const revenueId = await accountId(orgA, '4100');

    const v1 = await seedBudgetVersion(orgA, planId, userA.id, 'V1');
    await seedBudgetLine(orgA, v1, revenueId);
    await pool.query(
      `UPDATE forecaster_budget_versions SET status = 'APPROVED', approved_by = $2, approved_at = now()
        WHERE org_id = $1 AND id = $3`,
      [orgA, userA.id, v1],
    );

    const v2 = await seedBudgetVersion(orgA, planId, userA.id, 'V2');
    await seedBudgetLine(orgA, v2, revenueId);

    // Bypasses budgetService entirely — the point is that the partial unique
    // index, not the service, is what forbids a second APPROVED version.
    const code = await errorCode(() =>
      pool.query(
        `UPDATE forecaster_budget_versions SET status = 'APPROVED', approved_by = $2, approved_at = now()
          WHERE org_id = $1 AND id = $3`,
        [orgA, userA.id, v2],
      ),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('15. allows two APPROVED versions on different plans', async () => {
    const planIdA = await seedPlan(orgA, userA.id);
    const revenueIdA = await accountId(orgA, '4100');
    const v1 = await seedBudgetVersion(orgA, planIdA, userA.id, 'V1');
    await seedBudgetLine(orgA, v1, revenueIdA);
    await pool.query(
      `UPDATE forecaster_budget_versions SET status = 'APPROVED', approved_by = $2, approved_at = now()
        WHERE org_id = $1 AND id = $3`,
      [orgA, userA.id, v1],
    );

    const planIdB = await seedPlan(orgB, userB.id);
    const revenueIdB = await accountId(orgB, '4100');
    const v2 = await seedBudgetVersion(orgB, planIdB, userB.id, 'V2');
    await seedBudgetLine(orgB, v2, revenueIdB);

    const code = await errorCode(() =>
      pool.query(
        `UPDATE forecaster_budget_versions SET status = 'APPROVED', approved_by = $2, approved_at = now()
          WHERE org_id = $1 AND id = $3`,
        [orgB, userB.id, v2],
      ),
    );
    expect(code).toBeUndefined();
  });

  it('16. rejects an UPDATE to an APPROVED version own fields', async () => {
    const planId = await seedPlan(orgA, userA.id);
    const revenueId = await accountId(orgA, '4100');
    const v1 = await seedBudgetVersion(orgA, planId, userA.id, 'V1');
    await seedBudgetLine(orgA, v1, revenueId);
    await pool.query(
      `UPDATE forecaster_budget_versions SET status = 'APPROVED', approved_by = $2, approved_at = now()
        WHERE org_id = $1 AND id = $3`,
      [orgA, userA.id, v1],
    );

    const code = await errorCode(() =>
      pool.query(`UPDATE forecaster_budget_versions SET label = 'x' WHERE org_id = $1 AND id = $2`, [
        orgA,
        v1,
      ]),
    );
    expect(code).toBe(RAISED_EXCEPTION);
  });

  it('17. allows the APPROVED -> SUPERSEDED status move', async () => {
    const planId = await seedPlan(orgA, userA.id);
    const revenueId = await accountId(orgA, '4100');
    const v1 = await seedBudgetVersion(orgA, planId, userA.id, 'V1');
    await seedBudgetLine(orgA, v1, revenueId);
    await pool.query(
      `UPDATE forecaster_budget_versions SET status = 'APPROVED', approved_by = $2, approved_at = now()
        WHERE org_id = $1 AND id = $3`,
      [orgA, userA.id, v1],
    );

    const code = await errorCode(() =>
      pool.query(`UPDATE forecaster_budget_versions SET status = 'SUPERSEDED' WHERE org_id = $1 AND id = $2`, [
        orgA,
        v1,
      ]),
    );
    expect(code).toBeUndefined();
  });

  it('18. rejects a DELETE of a line on an APPROVED version', async () => {
    const planId = await seedPlan(orgA, userA.id);
    const revenueId = await accountId(orgA, '4100');
    const v1 = await seedBudgetVersion(orgA, planId, userA.id, 'V1');
    const lineId = await seedBudgetLine(orgA, v1, revenueId);
    await pool.query(
      `UPDATE forecaster_budget_versions SET status = 'APPROVED', approved_by = $2, approved_at = now()
        WHERE org_id = $1 AND id = $3`,
      [orgA, userA.id, v1],
    );

    const code = await errorCode(() =>
      pool.query('DELETE FROM forecaster_budget_lines WHERE org_id = $1 AND id = $2', [orgA, lineId]),
    );
    expect(code).toBe(RAISED_EXCEPTION);
  });

  it('19. rejects an INSERT of a line into an APPROVED version', async () => {
    const planId = await seedPlan(orgA, userA.id);
    const revenueId = await accountId(orgA, '4100');
    const expenseId = await accountId(orgA, '6100');
    const v1 = await seedBudgetVersion(orgA, planId, userA.id, 'V1');
    await seedBudgetLine(orgA, v1, revenueId);
    await pool.query(
      `UPDATE forecaster_budget_versions SET status = 'APPROVED', approved_by = $2, approved_at = now()
        WHERE org_id = $1 AND id = $3`,
      [orgA, userA.id, v1],
    );

    const code = await errorCode(() => seedBudgetLine(orgA, v1, expenseId));
    expect(code).toBe(RAISED_EXCEPTION);
  });

  it('20. allows deleting a line while its version is still DRAFT', async () => {
    const planId = await seedPlan(orgA, userA.id);
    const revenueId = await accountId(orgA, '4100');
    const v1 = await seedBudgetVersion(orgA, planId, userA.id, 'V1');
    const lineId = await seedBudgetLine(orgA, v1, revenueId);

    const code = await errorCode(() =>
      pool.query('DELETE FROM forecaster_budget_lines WHERE org_id = $1 AND id = $2', [orgA, lineId]),
    );
    expect(code).toBeUndefined();
  });
});
