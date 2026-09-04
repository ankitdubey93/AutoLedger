import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * The database as the guardrail, not the application — the bill half of
 * ledgerConstraints.test.ts. Every test here goes around `billService`,
 * straight at the pool, proving migration 013's triggers and CHECKs hold
 * regardless of what wrote the row.
 */

const FEATURE_NOT_SUPPORTED = '0A000';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';

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

async function insertVendor(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO vendors (org_id, created_by, name) VALUES ($1, $2, 'Raw SQL Vendor') RETURNING id`,
    [orgId, user.id],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no vendor id');
  return row.id;
}

async function insertDraftBill(vendorId: string, vendorReference = 'RAW-001'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO bills
       (org_id, vendor_id, vendor_reference, bill_date, due_date, currency_code,
        vendor_name_snapshot, subtotal_cents, tax_cents, total_cents, created_by)
     VALUES ($1, $2, $3, '2026-06-01', '2026-06-30', 'USD', 'Raw SQL Vendor', 25000, 4500, 29500, $4)
     RETURNING id`,
    [orgId, vendorId, vendorReference, user.id],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no bill id');
  return row.id;
}

async function insertLine(billId: string, expenseAccountId: string): Promise<void> {
  await pool.query(
    `INSERT INTO bill_lines
       (org_id, bill_id, line_number, description, quantity_milli, unit_price_cents,
        expense_account_id, tax_rate_bp, net_cents, tax_cents)
     VALUES ($1, $2, 1, 'Raw line', 2500, 10000, $3, 1800, 25000, 4500)`,
    [orgId, billId, expenseAccountId],
  );
}

/**
 * A minimal balanced journal entry, posted through an explicit transaction so
 * the deferred balance trigger sees both lines at COMMIT. `chk_bills_posted_complete`
 * requires a real journal_entry_id on a POSTED bill, so the fixture needs one
 * even though these tests are not about the GL posting itself.
 */
async function insertBalancedEntry(): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries (org_id, created_by, entry_date, description)
       VALUES ($1, $2, '2026-06-01', 'raw sql fixture') RETURNING id`,
      [orgId, user.id],
    );
    const entryId = rows[0]?.id;
    if (entryId === undefined) throw new Error('no entry id');

    await client.query(
      `INSERT INTO ledger_lines (org_id, journal_entry_id, account_id, debit_cents, credit_cents, currency_code, fx_rate, base_debit_cents, base_credit_cents)
       VALUES ($1, $2, $3, 29500, 0, 'USD', 1, 29500, 0)`,
      [orgId, entryId, await accountId('6130')],
    );
    await client.query(
      `INSERT INTO ledger_lines (org_id, journal_entry_id, account_id, debit_cents, credit_cents, currency_code, fx_rate, base_debit_cents, base_credit_cents)
       VALUES ($1, $2, $3, 0, 29500, 'USD', 1, 0, 29500)`,
      [orgId, entryId, await accountId('2100')],
    );

    await client.query('COMMIT');
    return entryId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Marks a bill POSTED via raw SQL — bypasses the service entirely. */
async function markPosted(billId: string): Promise<void> {
  const entryId = await insertBalancedEntry();
  await pool.query(
    `UPDATE bills SET status = 'POSTED', journal_entry_id = $2, posted_at = now(), approved_by = $3
      WHERE id = $1`,
    [billId, entryId, user.id],
  );
}

beforeEach(async () => {
  await resetTables();
  user = await createUserWithOrg({ label: 'raw', orgName: 'Raw SQL Org' });
  orgId = user.orgId;
});

afterAll(closePool);

describe('bill immutability, enforced by the database', () => {
  it('UPDATE on a POSTED bill amount raises 0A000', async () => {
    const vendorId = await insertVendor();
    const billId = await insertDraftBill(vendorId);
    await insertLine(billId, await accountId('6130'));
    await markPosted(billId);

    const code = await errorCode(() =>
      pool.query('UPDATE bills SET total_cents = 1 WHERE id = $1', [billId]),
    );

    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('DELETE on a POSTED bill raises 0A000', async () => {
    const vendorId = await insertVendor();
    const billId = await insertDraftBill(vendorId);
    await insertLine(billId, await accountId('6130'));
    await markPosted(billId);

    const code = await errorCode(() => pool.query('DELETE FROM bills WHERE id = $1', [billId]));

    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('the POSTED -> VOID update is allowed', async () => {
    const vendorId = await insertVendor();
    const billId = await insertDraftBill(vendorId);
    await insertLine(billId, await accountId('6130'));
    await markPosted(billId);

    await pool.query(
      `UPDATE bills SET status = 'VOID', voided_at = now(), void_journal_entry_id = NULL WHERE id = $1`,
      [billId],
    );

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM bills WHERE id = $1', [
      billId,
    ]);
    expect(rows[0]?.status).toBe('VOID');
  });

  it('a POSTED -> VOID update that also changes another field raises 0A000', async () => {
    const vendorId = await insertVendor();
    const billId = await insertDraftBill(vendorId);
    await insertLine(billId, await accountId('6130'));
    await markPosted(billId);

    const code = await errorCode(() =>
      pool.query(`UPDATE bills SET status = 'VOID', total_cents = 1 WHERE id = $1`, [billId]),
    );

    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('INSERT into bill_lines of a POSTED bill raises 0A000', async () => {
    const vendorId = await insertVendor();
    const billId = await insertDraftBill(vendorId);
    const expenseAccountId = await accountId('6130');
    await insertLine(billId, expenseAccountId);
    await markPosted(billId);

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO bill_lines
           (org_id, bill_id, line_number, description, quantity_milli, unit_price_cents,
            expense_account_id, tax_rate_bp, net_cents, tax_cents)
         VALUES ($1, $2, 2, 'Extra', 1000, 5000, $3, 0, 5000, 0)`,
        [orgId, billId, expenseAccountId],
      ),
    );

    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('UPDATE of a bill_line while AWAITING_APPROVAL succeeds', async () => {
    const vendorId = await insertVendor();
    const billId = await insertDraftBill(vendorId);
    const expenseAccountId = await accountId('6130');
    await insertLine(billId, expenseAccountId);
    await pool.query(`UPDATE bills SET status = 'AWAITING_APPROVAL', submitted_at = now() WHERE id = $1`, [
      billId,
    ]);

    await pool.query(`UPDATE bill_lines SET description = 'Edited while in review' WHERE bill_id = $1`, [
      billId,
    ]);

    const { rows } = await pool.query<{ description: string }>(
      'SELECT description FROM bill_lines WHERE bill_id = $1',
      [billId],
    );
    expect(rows[0]?.description).toBe('Edited while in review');
  });

  it('deleting a DRAFT bill cascades its lines', async () => {
    const vendorId = await insertVendor();
    const billId = await insertDraftBill(vendorId);
    await insertLine(billId, await accountId('6130'));

    await pool.query('DELETE FROM bills WHERE id = $1', [billId]);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) FROM bill_lines WHERE bill_id = $1',
      [billId],
    );
    expect(rows[0]?.count).toBe('0');
  });
});

describe('bill CHECK, UNIQUE and FK constraints', () => {
  it('total_cents <> subtotal + tax is rejected', async () => {
    const vendorId = await insertVendor();

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO bills
           (org_id, vendor_id, vendor_reference, bill_date, due_date, currency_code,
            vendor_name_snapshot, subtotal_cents, tax_cents, total_cents, created_by)
         VALUES ($1, $2, 'BAD-1', '2026-06-01', '2026-06-30', 'USD', 'Raw SQL Vendor', 100, 10, 999, $3)`,
        [orgId, vendorId, user.id],
      ),
    );

    expect(code).toBe(CHECK_VIOLATION);
  });

  it('due_date before bill_date is rejected', async () => {
    const vendorId = await insertVendor();

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO bills
           (org_id, vendor_id, vendor_reference, bill_date, due_date, currency_code,
            vendor_name_snapshot, subtotal_cents, tax_cents, total_cents, created_by)
         VALUES ($1, $2, 'BAD-2', '2026-06-10', '2026-06-01', 'USD', 'Raw SQL Vendor', 100, 0, 100, $3)`,
        [orgId, vendorId, user.id],
      ),
    );

    expect(code).toBe(CHECK_VIOLATION);
  });

  it('a POSTED bill without a journal_entry_id is rejected', async () => {
    const vendorId = await insertVendor();

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO bills
           (org_id, vendor_id, vendor_reference, bill_date, due_date, currency_code,
            vendor_name_snapshot, status, subtotal_cents, tax_cents, total_cents, created_by)
         VALUES ($1, $2, 'BAD-3', '2026-06-01', '2026-06-30', 'USD', 'Raw SQL Vendor', 'POSTED', 100, 0, 100, $3)`,
        [orgId, vendorId, user.id],
      ),
    );

    expect(code).toBe(CHECK_VIOLATION);
  });

  it('a duplicate (org, vendor, vendor_reference) is rejected', async () => {
    const vendorId = await insertVendor();
    await insertDraftBill(vendorId, 'DUP-1');

    const code = await errorCode(() => insertDraftBill(vendorId, 'DUP-1'));

    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it("a bill cannot reference another org's vendor", async () => {
    const otherOrg = await createUserWithOrg({ label: 'other', orgName: 'Other Org' });
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO vendors (org_id, created_by, name) VALUES ($1, $2, 'Foreign Vendor') RETURNING id`,
      [otherOrg.orgId, otherOrg.id],
    );
    const foreignVendorId = rows[0]?.id;
    if (foreignVendorId === undefined) throw new Error('no foreign vendor id');

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO bills
           (org_id, vendor_id, vendor_reference, bill_date, due_date, currency_code,
            vendor_name_snapshot, subtotal_cents, tax_cents, total_cents, created_by)
         VALUES ($1, $2, 'BAD-4', '2026-06-01', '2026-06-30', 'USD', 'Foreign Vendor', 100, 0, 100, $3)`,
        [orgId, foreignVendorId, user.id],
      ),
    );

    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("a bill_line cannot reference another org's expense account", async () => {
    const otherOrg = await createUserWithOrg({ label: 'other2', orgName: 'Other Org 2' });
    const { rows: foreignAccountRows } = await pool.query<{ id: string }>(
      "SELECT id FROM accounts WHERE org_id = $1 AND code = '6130'",
      [otherOrg.orgId],
    );
    const foreignAccountId = foreignAccountRows[0]?.id;
    if (foreignAccountId === undefined) throw new Error('no foreign account id');

    const vendorId = await insertVendor();
    const billId = await insertDraftBill(vendorId);

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO bill_lines
           (org_id, bill_id, line_number, description, quantity_milli, unit_price_cents,
            expense_account_id, tax_rate_bp, net_cents, tax_cents)
         VALUES ($1, $2, 1, 'Cross-tenant line', 1000, 5000, $3, 0, 5000, 0)`,
        [orgId, billId, foreignAccountId],
      ),
    );

    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });
});
