import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * The database as the guardrail, not the application — proving migration
 * 058's CHECK and UNIQUE constraints hold regardless of what wrote the row.
 */

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

async function constraintName(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'constraint' in err) {
      return typeof err.constraint === 'string' ? err.constraint : undefined;
    }
  }
  return undefined;
}

let userA: SeededUser;
let userB: SeededUser;

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
});

afterAll(closePool);

describe('payment_terms CHECK and UNIQUE constraints', () => {
  it('a lowercase code is rejected by the CHECK', async () => {
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO payment_terms (org_id, code, name, net_days) VALUES ($1, 'net_30', 'Net 30', 30)`,
        [userA.orgId],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('net_days above 365 is rejected', async () => {
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO payment_terms (org_id, code, name, net_days) VALUES ($1, 'NET_400', 'Net 400', 400)`,
        [userA.orgId],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('a duplicate (org_id, code) is rejected', async () => {
    const constraint = await constraintName(() =>
      pool.query(
        `INSERT INTO payment_terms (org_id, code, name, net_days) VALUES ($1, 'NET_30', 'Net 30 duplicate', 30)`,
        [userA.orgId],
      ),
    );
    expect(constraint).toBe('ux_payment_terms_org_code');
  });

  it('the same code in two organizations is allowed', async () => {
    await pool.query(
      `INSERT INTO payment_terms (org_id, code, name, net_days) VALUES ($1, 'NET_33', 'Net 33', 33)`,
      [userA.orgId],
    );
    await pool.query(
      `INSERT INTO payment_terms (org_id, code, name, net_days) VALUES ($1, 'NET_33', 'Net 33', 33)`,
      [userB.orgId],
    );

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM payment_terms WHERE code = 'NET_33'`,
    );
    expect(Number(rows[0]?.count)).toBe(2);
  });
});
