import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * The database as the guardrail, not the application — proving migration
 * 059's CHECK, UNIQUE and composite-FK constraints hold regardless of what
 * wrote the row.
 */

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

describe('items CHECK, UNIQUE and composite-FK constraints', () => {
  it('kind outside SERVICE/GOODS is rejected', async () => {
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO items (org_id, created_by, code, name, kind, item_type) VALUES ($1, $2, 'X', 'X item', 'BAD_KIND', 'SERVICE')`,
        [userA.orgId, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('a negative sale_price_cents is rejected', async () => {
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO items (org_id, created_by, code, name, kind, item_type, sale_price_cents)
         VALUES ($1, $2, 'X', 'X item', 'SERVICE', 'SERVICE', -100)`,
        [userA.orgId, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('sale_tax_rate_bp above 10000 is rejected', async () => {
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO items (org_id, created_by, code, name, kind, item_type, sale_tax_rate_bp)
         VALUES ($1, $2, 'X', 'X item', 'SERVICE', 'SERVICE', 10001)`,
        [userA.orgId, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('a duplicate (org_id, code) is rejected', async () => {
    await pool.query(
      `INSERT INTO items (org_id, created_by, code, name, kind, item_type) VALUES ($1, $2, 'DUP', 'First', 'SERVICE', 'SERVICE')`,
      [userA.orgId, userA.id],
    );
    const constraint = await constraintName(() =>
      pool.query(`INSERT INTO items (org_id, created_by, code, name, kind, item_type) VALUES ($1, $2, 'DUP', 'Second', 'SERVICE', 'SERVICE')`, [
        userA.orgId,
        userA.id,
      ]),
    );
    expect(constraint).toBe('ux_items_org_code');
  });

  it('an account from another organization is rejected by the composite FK', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM accounts WHERE org_id = $1 AND code = '4100'`,
      [userB.orgId],
    );
    const otherOrgAccountId = rows[0]?.id;
    if (otherOrgAccountId === undefined) throw new Error('fixture: no org B revenue account');

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO items (org_id, created_by, code, name, kind, item_type, revenue_account_id)
         VALUES ($1, $2, 'X', 'X item', 'SERVICE', 'SERVICE', $3)`,
        [userA.orgId, userA.id, otherOrgAccountId],
      ),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });
});
