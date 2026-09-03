import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * The database as the guardrail, not the application — the invoice half of
 * ledgerConstraints.test.ts. Every test here goes around `invoiceService`,
 * straight at the pool, proving migration 009's triggers and CHECKs hold
 * regardless of what wrote the row.
 */

const FEATURE_NOT_SUPPORTED = '0A000';
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

async function insertCustomer(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO customers (org_id, created_by, name) VALUES ($1, $2, 'Raw SQL Co') RETURNING id`,
    [orgId, user.id],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no customer id');
  return row.id;
}

async function insertDraftInvoice(customerId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO invoices
       (org_id, customer_id, issue_date, due_date, currency_code,
        customer_name_snapshot, subtotal_cents, tax_cents, total_cents, created_by)
     VALUES ($1, $2, '2026-06-01', '2026-06-30', 'USD', 'Raw SQL Co', 25000, 4500, 29500, $3)
     RETURNING id`,
    [orgId, customerId, user.id],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no invoice id');
  return row.id;
}

async function insertLine(invoiceId: string, revenueAccountId: string): Promise<void> {
  await pool.query(
    `INSERT INTO invoice_lines
       (org_id, invoice_id, line_number, description, quantity_milli, unit_price_cents,
        revenue_account_id, tax_rate_bp, net_cents, tax_cents)
     VALUES ($1, $2, 1, 'Raw line', 2500, 10000, $3, 1800, 25000, 4500)`,
    [orgId, invoiceId, revenueAccountId],
  );
}

/**
 * A minimal balanced journal entry, posted through an explicit transaction so
 * the deferred balance trigger sees both lines at COMMIT. `chk_invoices_issued_complete`
 * requires a real journal_entry_id on an ISSUED invoice, so the fixture needs
 * one even though these tests are not about the GL posting itself.
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
      [orgId, entryId, await accountId('1120')],
    );
    await client.query(
      `INSERT INTO ledger_lines (org_id, journal_entry_id, account_id, debit_cents, credit_cents, currency_code, fx_rate, base_debit_cents, base_credit_cents)
       VALUES ($1, $2, $3, 0, 29500, 'USD', 1, 0, 29500)`,
      [orgId, entryId, await accountId('4100')],
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

/** Issues a draft invoice via raw SQL — bypasses the service entirely. */
async function markIssued(invoiceId: string): Promise<void> {
  const entryId = await insertBalancedEntry();
  await pool.query(
    `UPDATE invoices SET status = 'ISSUED', invoice_number = 'INV-RAW-001',
            journal_entry_id = $2, issued_at = now()
      WHERE id = $1`,
    [invoiceId, entryId],
  );
}

beforeEach(async () => {
  await resetTables();
  user = await createUserWithOrg({ label: 'raw', orgName: 'Raw SQL Org' });
  orgId = user.orgId;
});

afterAll(closePool);

describe('invoice immutability, enforced by the database', () => {
  it('UPDATE on an ISSUED invoice amount raises 0A000', async () => {
    const customerId = await insertCustomer();
    const invoiceId = await insertDraftInvoice(customerId);
    await insertLine(invoiceId, await accountId('4100'));
    await markIssued(invoiceId);

    const code = await errorCode(() =>
      pool.query('UPDATE invoices SET total_cents = 1 WHERE id = $1', [invoiceId]),
    );

    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('DELETE on an ISSUED invoice raises 0A000', async () => {
    const customerId = await insertCustomer();
    const invoiceId = await insertDraftInvoice(customerId);
    await insertLine(invoiceId, await accountId('4100'));
    await markIssued(invoiceId);

    const code = await errorCode(() => pool.query('DELETE FROM invoices WHERE id = $1', [invoiceId]));

    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('the ISSUED -> VOID update is allowed', async () => {
    const customerId = await insertCustomer();
    const invoiceId = await insertDraftInvoice(customerId);
    await insertLine(invoiceId, await accountId('4100'));
    await markIssued(invoiceId);

    await pool.query(
      `UPDATE invoices SET status = 'VOID', voided_at = now(), void_journal_entry_id = NULL WHERE id = $1`,
      [invoiceId],
    );

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM invoices WHERE id = $1', [
      invoiceId,
    ]);
    expect(rows[0]?.status).toBe('VOID');
  });

  it('a VOID -> ISSUED update raises 0A000', async () => {
    const customerId = await insertCustomer();
    const invoiceId = await insertDraftInvoice(customerId);
    await insertLine(invoiceId, await accountId('4100'));
    await markIssued(invoiceId);
    await pool.query(
      `UPDATE invoices SET status = 'VOID', voided_at = now() WHERE id = $1`,
      [invoiceId],
    );

    const code = await errorCode(() =>
      pool.query(`UPDATE invoices SET status = 'ISSUED' WHERE id = $1`, [invoiceId]),
    );

    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('INSERT into invoice_lines of an ISSUED invoice raises 0A000', async () => {
    const customerId = await insertCustomer();
    const invoiceId = await insertDraftInvoice(customerId);
    const revenueAccountId = await accountId('4100');
    await insertLine(invoiceId, revenueAccountId);
    await markIssued(invoiceId);

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO invoice_lines
           (org_id, invoice_id, line_number, description, quantity_milli, unit_price_cents,
            revenue_account_id, tax_rate_bp, net_cents, tax_cents)
         VALUES ($1, $2, 2, 'Extra', 1000, 5000, $3, 0, 5000, 0)`,
        [orgId, invoiceId, revenueAccountId],
      ),
    );

    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it("DELETE of an ISSUED invoice's line raises 0A000", async () => {
    const customerId = await insertCustomer();
    const invoiceId = await insertDraftInvoice(customerId);
    await insertLine(invoiceId, await accountId('4100'));
    await markIssued(invoiceId);

    const code = await errorCode(() =>
      pool.query('DELETE FROM invoice_lines WHERE invoice_id = $1', [invoiceId]),
    );

    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('deleting a DRAFT invoice cascades its lines', async () => {
    const customerId = await insertCustomer();
    const invoiceId = await insertDraftInvoice(customerId);
    await insertLine(invoiceId, await accountId('4100'));

    await pool.query('DELETE FROM invoices WHERE id = $1', [invoiceId]);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) FROM invoice_lines WHERE invoice_id = $1',
      [invoiceId],
    );
    expect(rows[0]?.count).toBe('0');
  });
});

describe('invoice CHECK and FK constraints', () => {
  it('total_cents <> subtotal + tax is rejected', async () => {
    const customerId = await insertCustomer();

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO invoices
           (org_id, customer_id, issue_date, due_date, currency_code,
            customer_name_snapshot, subtotal_cents, tax_cents, total_cents, created_by)
         VALUES ($1, $2, '2026-06-01', '2026-06-30', 'USD', 'Raw SQL Co', 100, 10, 999, $3)`,
        [orgId, customerId, user.id],
      ),
    );

    expect(code).toBe(CHECK_VIOLATION);
  });

  it('an ISSUED invoice without a number is rejected', async () => {
    const customerId = await insertCustomer();

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO invoices
           (org_id, customer_id, issue_date, due_date, currency_code,
            customer_name_snapshot, status, subtotal_cents, tax_cents, total_cents, created_by)
         VALUES ($1, $2, '2026-06-01', '2026-06-30', 'USD', 'Raw SQL Co', 'ISSUED', 100, 0, 100, $3)`,
        [orgId, customerId, user.id],
      ),
    );

    expect(code).toBe(CHECK_VIOLATION);
  });

  it("an invoice cannot reference another org's customer", async () => {
    const otherOrg = await createUserWithOrg({ label: 'other', orgName: 'Other Org' });
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO customers (org_id, created_by, name) VALUES ($1, $2, 'Foreign Co') RETURNING id`,
      [otherOrg.orgId, otherOrg.id],
    );
    const foreignCustomerId = rows[0]?.id;
    if (foreignCustomerId === undefined) throw new Error('no foreign customer id');

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO invoices
           (org_id, customer_id, issue_date, due_date, currency_code,
            customer_name_snapshot, subtotal_cents, tax_cents, total_cents, created_by)
         VALUES ($1, $2, '2026-06-01', '2026-06-30', 'USD', 'Foreign Co', 100, 0, 100, $3)`,
        [orgId, foreignCustomerId, user.id],
      ),
    );

    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });
});
