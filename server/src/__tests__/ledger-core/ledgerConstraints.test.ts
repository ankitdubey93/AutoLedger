import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * The database as the guardrail, not the application.
 *
 * Every test here goes **around** `journalService`, straight at the pool. That
 * is the entire point: the service validates the balance invariant too, and a
 * test that posts through it proves only that the service is correct. These
 * prove that a data-fix script, a future module, a migration, or a hand-typed
 * `psql` statement cannot write an unbalanced or mutated ledger either.
 *
 * The prior build enforced this class of rule in application code alone, and
 * its `isBalanced` check used a floating-point epsilon. Both failures are
 * structurally impossible against this schema.
 */

const RAISE_EXCEPTION = 'P0001';
const FEATURE_NOT_SUPPORTED = '0A000';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

/** Runs a statement and returns its SQLSTATE, without an `any` cast. */
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

async function accountId(code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code}`);
  return row.id;
}

/** Inserts a bare entry header and returns its id, on the given client. */
async function insertEntry(client: { query: typeof pool.query }): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journal_entries (org_id, created_by, entry_date, description)
     VALUES ($1, $2, '2026-08-15', 'raw sql') RETURNING id`,
    [orgId, user.id],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no entry id');
  return row.id;
}

async function insertLine(
  client: { query: typeof pool.query },
  entryId: string,
  code: string,
  debit: number,
  credit: number,
): Promise<void> {
  await client.query(
    `INSERT INTO ledger_lines
       (org_id, journal_entry_id, account_id, debit_cents, credit_cents,
        currency_code, fx_rate, base_debit_cents, base_credit_cents)
     VALUES ($1, $2, $3, $4, $5, 'USD', 1, $4, $5)`,
    [orgId, entryId, await accountId(code), debit, credit],
  );
}

beforeEach(async () => {
  await resetTables();
  user = await createUserWithOrg({ label: 'raw', orgName: 'Raw SQL Co' });
  orgId = user.orgId;
});

afterAll(closePool);

describe('the balance invariant is deferred to COMMIT', () => {
  it('accepts each unbalanced line individually, then rejects at COMMIT', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const entryId = await insertEntry(client);

      // Both inserts must SUCCEED. If either threw, the trigger is firing per
      // statement rather than at COMMIT, and a legitimate multi-line entry
      // could never be written a line at a time.
      await insertLine(client, entryId, '1110', 100, 0);
      await insertLine(client, entryId, '4200', 0, 90);

      const code = await errorCode(() => client.query('COMMIT'));
      expect(code).toBe(RAISE_EXCEPTION);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM journal_entries WHERE org_id = $1',
      [orgId],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('rejects a journal entry with zero lines at COMMIT', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Never touches ledger_lines, so only the trigger on journal_entries can
      // catch this. Without it, "debits equal credits" is vacuously true.
      await insertEntry(client);
      expect(await errorCode(() => client.query('COMMIT'))).toBe(RAISE_EXCEPTION);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('rejects a single-line entry at COMMIT', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const entryId = await insertEntry(client);
      await insertLine(client, entryId, '1110', 100, 0);
      expect(await errorCode(() => client.query('COMMIT'))).toBe(RAISE_EXCEPTION);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('accepts a balanced multi-line entry written by raw SQL', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const entryId = await insertEntry(client);
      await insertLine(client, entryId, '6120', 30000, 0);
      await insertLine(client, entryId, '6130', 15000, 0);
      await insertLine(client, entryId, '2100', 0, 45000);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM journal_entries WHERE org_id = $1',
      [orgId],
    );
    expect(rows[0]?.count).toBe('1');
  });
});

describe('row-level CHECK constraints', () => {
  it('rejects a line with both a debit and a credit', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const entryId = await insertEntry(client);
      expect(await errorCode(() => insertLine(client, entryId, '1110', 100, 100))).toBe(
        CHECK_VIOLATION,
      );
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('rejects a line with neither a debit nor a credit', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const entryId = await insertEntry(client);
      expect(await errorCode(() => insertLine(client, entryId, '1110', 0, 0))).toBe(
        CHECK_VIOLATION,
      );
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('rejects a negative amount', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const entryId = await insertEntry(client);
      expect(await errorCode(() => insertLine(client, entryId, '1110', -100, 0))).toBe(
        CHECK_VIOLATION,
      );
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});

describe('posting guard', () => {
  it('rejects a posting to a header account, immediately', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const entryId = await insertEntry(client);
      // Not deferred: this depends on one row, so there is no reason to wait.
      expect(await errorCode(() => insertLine(client, entryId, '1000', 100, 0))).toBe(
        RAISE_EXCEPTION,
      );
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it("rejects a line whose account belongs to another organization", async () => {
    const other = await createUserWithOrg({ label: 'other', orgName: 'Other Co' });
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
      [other.orgId, '1110'],
    );
    const foreignAccount = rows[0]?.id;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const entryId = await insertEntry(client);
      // The tenancy boundary enforced by the database itself, not only by the
      // service — a future module writing lines directly cannot cross tenants.
      const code = await errorCode(() =>
        client.query(
          `INSERT INTO ledger_lines
             (org_id, journal_entry_id, account_id, debit_cents, credit_cents,
              currency_code, fx_rate, base_debit_cents, base_credit_cents)
           VALUES ($1, $2, $3, 100, 0, 'USD', 1, 100, 0)`,
          [orgId, entryId, foreignAccount],
        ),
      );
      expect(code).toBe(RAISE_EXCEPTION);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});

describe('immutability', () => {
  let entryId: string;

  beforeEach(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      entryId = await insertEntry(client);
      await insertLine(client, entryId, '6120', 45000, 0);
      await insertLine(client, entryId, '2100', 0, 45000);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('UPDATE on a posted journal entry raises 0A000', async () => {
    const code = await errorCode(() =>
      pool.query('UPDATE journal_entries SET description = $1 WHERE id = $2', ['tampered', entryId]),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('DELETE on a posted journal entry raises 0A000', async () => {
    expect(await errorCode(() => pool.query('DELETE FROM journal_entries WHERE id = $1', [entryId])))
      .toBe(FEATURE_NOT_SUPPORTED);
  });

  it('UPDATE on a posted ledger line raises 0A000', async () => {
    const code = await errorCode(() =>
      pool.query('UPDATE ledger_lines SET debit_cents = 1 WHERE journal_entry_id = $1', [entryId]),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('DELETE on a posted ledger line raises 0A000', async () => {
    const code = await errorCode(() =>
      pool.query('DELETE FROM ledger_lines WHERE journal_entry_id = $1', [entryId]),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('an organization with posted journals cannot be deleted', async () => {
    // ON DELETE RESTRICT, deliberately not CASCADE: a cascade would reach the
    // immutability trigger and abort mid-cascade. Failing at the parent with a
    // clear FK error is the better failure.
    expect(await errorCode(() => pool.query('DELETE FROM organizations WHERE id = $1', [orgId])))
      .toBe(FOREIGN_KEY_VIOLATION);
  });

  it('an account with postings cannot be deleted', async () => {
    const cash = await accountId('6120');
    expect(await errorCode(() => pool.query('DELETE FROM accounts WHERE id = $1', [cash]))).toBe(
      FOREIGN_KEY_VIOLATION,
    );
  });
});

describe('global integrity — the check you run in front of an auditor', () => {
  it('total debits equal total credits across the entire table', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const entryId = await insertEntry(client);
      await insertLine(client, entryId, '6120', 45000, 0);
      await insertLine(client, entryId, '2100', 0, 45000);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const { rows } = await pool.query<{ difference: string }>(
      `SELECT COALESCE(SUM(debit_cents), 0) - COALESCE(SUM(credit_cents), 0) AS difference
         FROM ledger_lines`,
    );
    // Integer equality across every tenant at once, not an epsilon.
    expect(rows[0]?.difference).toBe('0');
  });

  it('no individual entry is unbalanced', async () => {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM (
         SELECT journal_entry_id
           FROM ledger_lines
          GROUP BY journal_entry_id
         HAVING SUM(debit_cents) <> SUM(credit_cents)
              OR SUM(base_debit_cents) <> SUM(base_credit_cents)
              OR count(*) < 2
       ) unbalanced`,
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('no ledger line is orphaned', async () => {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM ledger_lines l
        WHERE NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.id = l.journal_entry_id)`,
    );
    expect(rows[0]?.count).toBe('0');
  });
});
