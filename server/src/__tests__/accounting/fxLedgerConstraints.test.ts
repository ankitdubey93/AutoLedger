import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { convertToBase } from '../../utils/fxRate.js';
import { cents } from '../../utils/money.js';

/**
 * The database as the guardrail for Phase 8's balance rule, not the
 * application — mirroring ledgerConstraints.test.ts exactly: every test here
 * goes around journalService, straight at the pool, so it proves the
 * invariant holds independently of any service being correct.
 */

const RAISE_EXCEPTION = 'P0001';
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
let otherOrgId: string;

async function accountId(org: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [org, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} for org ${org}`);
  return row.id;
}

async function insertEntry(client: { query: typeof pool.query }, org: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journal_entries (org_id, created_by, entry_date, description)
     VALUES ($1, $2, '2026-08-15', 'raw sql fx') RETURNING id`,
    [org, user.id],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no entry id');
  return row.id;
}

async function insertFxLine(
  client: { query: typeof pool.query },
  org: string,
  entryId: string,
  accountCode: string,
  currencyCode: string,
  rate: string,
  debit: number,
  credit: number,
  baseDebit: number,
  baseCredit: number,
): Promise<void> {
  await client.query(
    `INSERT INTO ledger_lines
       (org_id, journal_entry_id, account_id, debit_cents, credit_cents,
        currency_code, fx_rate, base_debit_cents, base_credit_cents)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [org, entryId, await accountId(org, accountCode), debit, credit, currencyCode, rate, baseDebit, baseCredit],
  );
}

beforeEach(async () => {
  await resetTables();
  user = await createUserWithOrg({ label: 'fxraw', orgName: 'FX Raw SQL Co' });
  orgId = user.orgId;

  const other = await createUserWithOrg({ label: 'fxraw2', orgName: 'FX Raw SQL Co 2' });
  otherOrgId = other.orgId;
});

afterAll(closePool);

describe('base currency is what balances', () => {
  it('a mixed-currency entry that balances in base currency commits', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const entryId = await insertEntry(client, orgId);

      // debit 1110 INR 8350000 at rate 1; credit 1120 USD 100000 at 83.00
      // (base 8300000); credit 4910 INR 50000 at rate 1. Native sums
      // (8350000 vs 150000) do NOT match — that is the point.
      await insertFxLine(client, orgId, entryId, '1110', 'INR', '1.00000000', 8350000, 0, 8350000, 0);
      await insertFxLine(client, orgId, entryId, '1120', 'USD', '83.00000000', 0, 100000, 0, 8300000);
      await insertFxLine(client, orgId, entryId, '4910', 'INR', '1.00000000', 0, 50000, 0, 50000);

      const code = await errorCode(() => client.query('COMMIT'));
      expect(code).toBeUndefined();
    } finally {
      client.release();
    }
  });

  it('a mixed-currency entry that does not balance in base currency is rejected at COMMIT', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const entryId = await insertEntry(client, orgId);

      await insertFxLine(client, orgId, entryId, '1110', 'INR', '1.00000000', 8350000, 0, 8350000, 0);
      await insertFxLine(client, orgId, entryId, '1120', 'USD', '83.00000000', 0, 100000, 0, 8300000);
      // 40000, not 50000 — base sides no longer match.
      await insertFxLine(client, orgId, entryId, '4910', 'INR', '1.00000000', 0, 40000, 0, 40000);

      const code = await errorCode(() => client.query('COMMIT'));
      expect(code).toBe(RAISE_EXCEPTION);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('a single-currency entry is still checked natively', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const entryId = await insertEntry(client, orgId);

      // Both lines INR at rate 1: debit 1000, credit 900 — unbalanced both
      // natively and in base currency, but it is the NATIVE message that
      // must fire, proving the single-currency branch runs first.
      await insertFxLine(client, orgId, entryId, '1110', 'INR', '1.00000000', 1000, 0, 1000, 0);
      await insertFxLine(client, orgId, entryId, '4200', 'INR', '1.00000000', 0, 900, 0, 900);

      let message: string | undefined;
      try {
        await client.query('COMMIT');
      } catch (err) {
        message = err instanceof Error ? err.message : undefined;
      }
      expect(message).toContain('is unbalanced (debits=');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('a line whose base amount does not match its rate is rejected on INSERT', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const entryId = await insertEntry(client, orgId);

      // debit_cents = 100000, fx_rate = 83.00000000, but base_debit_cents is
      // one cent short of round(100000 * 83) = 8300000.
      const code = await errorCode(() =>
        insertFxLine(client, orgId, entryId, '1120', 'USD', '83.00000000', 100000, 0, 8299999, 0),
      );
      expect(code).toBe(CHECK_VIOLATION);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('round-half-up agrees between the service and the database', () => {
    expect(convertToBase(cents(1), '0.50000000')).toBe(1);
    expect(convertToBase(cents(1), '0.00500000')).toBe(0);
  });

  it('round-half-up: base_debit_cents = 1 commits, base_debit_cents = 0 is rejected', async () => {
    const commitClient = await pool.connect();
    try {
      await commitClient.query('BEGIN');
      const entryId = await insertEntry(commitClient, orgId);
      await insertFxLine(commitClient, orgId, entryId, '1120', 'USD', '0.50000000', 1, 0, 1, 0);
      await insertFxLine(commitClient, orgId, entryId, '4200', 'USD', '0.50000000', 0, 1, 0, 1);
      const code = await errorCode(() => commitClient.query('COMMIT'));
      expect(code).toBeUndefined();
    } finally {
      commitClient.release();
    }

    const rejectClient = await pool.connect();
    try {
      await rejectClient.query('BEGIN');
      const entryId = await insertEntry(rejectClient, orgId);
      const code = await errorCode(() =>
        insertFxLine(rejectClient, orgId, entryId, '1120', 'USD', '0.50000000', 1, 0, 0, 0),
      );
      expect(code).toBe(CHECK_VIOLATION);
    } finally {
      await rejectClient.query('ROLLBACK').catch(() => undefined);
      rejectClient.release();
    }
  });

  it('cross-tenant: a line referencing another org account is still rejected by the postable-account guard', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const entryId = await insertEntry(client, orgId);
      const otherOrgAccount = await accountId(otherOrgId, '1110');

      const code = await errorCode(() =>
        client.query(
          `INSERT INTO ledger_lines
             (org_id, journal_entry_id, account_id, debit_cents, credit_cents,
              currency_code, fx_rate, base_debit_cents, base_credit_cents)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [orgId, entryId, otherOrgAccount, 100, 0, 'USD', '1.00000000', 100, 0],
        ),
      );
      // account_id exists but not for (account_id, org_id) — assert_account_is_postable
      // raises P0001 "account % does not exist in organization %".
      expect(code).toBe(RAISE_EXCEPTION);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
