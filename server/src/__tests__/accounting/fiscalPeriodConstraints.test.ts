import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * The database as the guardrail, not the application — proving migration
 * 015's EXCLUDE constraint and CHECKs hold regardless of what wrote the row.
 * Every test here goes around `fiscalPeriodService`, straight at the pool.
 */

const EXCLUSION_VIOLATION = '23P01';
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

let user: SeededUser;
let orgId: string;

async function insertPeriod(
  org: string,
  startsOn: string,
  endsOn: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO fiscal_periods
       (org_id, created_by, fiscal_year_label, period_number, starts_on, ends_on,
        status, closed_by, closed_at)
     VALUES ($1, $2, 'FY 2026', $3, $4, $5, $6, $7, $8)`,
    [
      org,
      user.id,
      overrides.periodNumber ?? 1,
      startsOn,
      endsOn,
      overrides.status ?? 'OPEN',
      overrides.closedBy ?? null,
      overrides.closedAt ?? null,
    ],
  );
}

beforeEach(async () => {
  await resetTables();
  user = await createUserWithOrg({ label: 'raw-sql-user' });
  orgId = user.orgId;
});

afterAll(async () => {
  await closePool();
});

describe('ex_fiscal_periods_no_overlap', () => {
  it('rejects two overlapping ranges in the same organization', async () => {
    await insertPeriod(orgId, '2026-01-01', '2026-01-31');

    const code = await errorCode(() => insertPeriod(orgId, '2026-01-15', '2026-02-15', { periodNumber: 2 }));

    expect(code).toBe(EXCLUSION_VIOLATION);
  });

  it('permits the identical overlapping range under a different organization', async () => {
    const other = await createUserWithOrg({ label: 'other-org-user' });

    await insertPeriod(orgId, '2026-01-01', '2026-01-31');
    const code = await errorCode(() => insertPeriod(other.orgId, '2026-01-15', '2026-02-15', { periodNumber: 2 }));

    expect(code).toBeUndefined();
  });

  it('permits adjacent, non-overlapping ranges', async () => {
    await insertPeriod(orgId, '2026-01-01', '2026-01-31');

    const code = await errorCode(() => insertPeriod(orgId, '2026-02-01', '2026-02-28', { periodNumber: 2 }));

    expect(code).toBeUndefined();
  });
});

describe('chk_fiscal_periods_closed_complete', () => {
  it('rejects a CLOSED row with closed_by/closed_at left NULL', async () => {
    const code = await errorCode(() => insertPeriod(orgId, '2026-01-01', '2026-01-31', { status: 'CLOSED' }));

    expect(code).toBe(CHECK_VIOLATION);
  });
});

describe('chk_fiscal_periods_range', () => {
  it('rejects ends_on before starts_on', async () => {
    const code = await errorCode(() => insertPeriod(orgId, '2026-01-31', '2026-01-01'));

    expect(code).toBe(CHECK_VIOLATION);
  });
});

describe('period_number range', () => {
  it('rejects period_number 13', async () => {
    const code = await errorCode(() =>
      insertPeriod(orgId, '2026-01-01', '2026-01-31', { periodNumber: 13 }),
    );

    expect(code).toBe(CHECK_VIOLATION);
  });
});
