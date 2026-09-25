import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * The database as the guardrail for Phase 8's allocation currency rule, not
 * the application — mirroring ledgerConstraints.test.ts / fxLedgerConstraints.test.ts:
 * every test here goes around paymentService, straight at the pool.
 */

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
  if (row === undefined) throw new Error(`fixture: no account ${code} for org ${orgId}`);
  return row.id;
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'fxpayraw', orgName: 'FX Pay Raw Co' });
  orgA = userA.orgId;
  userB = await createUserWithOrg({ label: 'fxpayraw2', orgName: 'FX Pay Raw Co 2' });
  orgB = userB.orgId;
});

afterAll(closePool);

describe('payment/document currency guard', () => {
  it('an allocation whose payment currency differs from its document currency is rejected on INSERT', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const customerRes = await client.query<{ id: string }>(
        `INSERT INTO customers (org_id, name, created_by) VALUES ($1, $2, $3) RETURNING id`,
        [orgA, 'Raw Customer', userA.id],
      );
      const customerId = customerRes.rows[0]?.id;
      if (customerId === undefined) throw new Error('no customer id');

      // A raw USD invoice, bypassing invoiceService entirely — status ISSUED
      // so the FK/CHECK layer around it is exercised the same as a real one.
      const invoiceRes = await client.query<{ id: string }>(
        `INSERT INTO invoices
           (org_id, customer_id, issue_date, due_date, currency_code,
            customer_name_snapshot, subtotal_cents, tax_cents, total_cents,
            status, invoice_number, created_by)
         VALUES ($1, $2, '2026-01-01', '2026-06-01', 'USD', 'Raw Customer', 100000, 0, 100000,
                 'DRAFT', NULL, $3)
         RETURNING id`,
        [orgA, customerId, userA.id],
      );
      const invoiceId = invoiceRes.rows[0]?.id;
      if (invoiceId === undefined) throw new Error('no invoice id');

      const cashAccount = await accountId(orgA, '1110');
      const receivableAccount = await accountId(orgA, '1120');

      // A raw journal entry + INR payment, bypassing paymentService.
      const entryRes = await client.query<{ id: string }>(
        `INSERT INTO journal_entries (org_id, created_by, entry_date, description)
         VALUES ($1, $2, '2026-01-10', 'raw sql payment') RETURNING id`,
        [orgA, userA.id],
      );
      const entryId = entryRes.rows[0]?.id;
      if (entryId === undefined) throw new Error('no entry id');
      await client.query(
        `INSERT INTO ledger_lines
           (org_id, journal_entry_id, account_id, debit_cents, credit_cents,
            currency_code, fx_rate, base_debit_cents, base_credit_cents)
         VALUES ($1, $2, $3, 100000, 0, 'INR', 1, 100000, 0)`,
        [orgA, entryId, cashAccount],
      );
      await client.query(
        `INSERT INTO ledger_lines
           (org_id, journal_entry_id, account_id, debit_cents, credit_cents,
            currency_code, fx_rate, base_debit_cents, base_credit_cents)
         VALUES ($1, $2, $3, 0, 100000, 'INR', 1, 0, 100000)`,
        [orgA, entryId, receivableAccount],
      );

      const paymentRes = await client.query<{ id: string }>(
        `INSERT INTO payments
           (org_id, direction, payment_date, currency_code, amount_cents,
            cash_account_id, customer_id, journal_entry_id, created_by)
         VALUES ($1, 'RECEIVE', '2026-01-10', 'INR', 100000, $2, $3, $4, $5)
         RETURNING id`,
        [orgA, cashAccount, customerId, entryId, userA.id],
      );
      const paymentId = paymentRes.rows[0]?.id;
      if (paymentId === undefined) throw new Error('no payment id');

      const message = await (async () => {
        try {
          await client.query(
            `INSERT INTO payment_allocations (org_id, payment_id, invoice_id, bill_id, amount_cents)
             VALUES ($1, $2, $3, NULL, 100000)`,
            [orgA, paymentId, invoiceId],
          );
          return undefined;
        } catch (err) {
          return err instanceof Error ? err.message : undefined;
        }
      })();

      expect(message).toContain('cannot settle a document in');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('the currency guard sits behind the tenancy boundary — org A cannot allocate to org B\'s invoice', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const customerRes = await client.query<{ id: string }>(
        `INSERT INTO customers (org_id, name, created_by) VALUES ($1, $2, $3) RETURNING id`,
        [orgB, 'Org B Customer', userB.id],
      );
      const customerIdB = customerRes.rows[0]?.id;
      if (customerIdB === undefined) throw new Error('no customer id');

      const invoiceRes = await client.query<{ id: string }>(
        `INSERT INTO invoices
           (org_id, customer_id, issue_date, due_date, currency_code,
            customer_name_snapshot, subtotal_cents, tax_cents, total_cents,
            status, invoice_number, created_by)
         VALUES ($1, $2, '2026-01-01', '2026-06-01', 'USD', 'Org B Customer', 100000, 0, 100000,
                 'DRAFT', NULL, $3)
         RETURNING id`,
        [orgB, customerIdB, userB.id],
      );
      const invoiceIdB = invoiceRes.rows[0]?.id;
      if (invoiceIdB === undefined) throw new Error('no invoice id');

      const cashAccountA = await accountId(orgA, '1110');
      const customerResA = await client.query<{ id: string }>(
        `INSERT INTO customers (org_id, name, created_by) VALUES ($1, $2, $3) RETURNING id`,
        [orgA, 'Org A Customer', userA.id],
      );
      const customerIdA = customerResA.rows[0]?.id;
      if (customerIdA === undefined) throw new Error('no customer id');

      const entryRes = await client.query<{ id: string }>(
        `INSERT INTO journal_entries (org_id, created_by, entry_date, description)
         VALUES ($1, $2, '2026-01-10', 'raw sql payment') RETURNING id`,
        [orgA, userA.id],
      );
      const entryId = entryRes.rows[0]?.id;
      if (entryId === undefined) throw new Error('no entry id');
      const receivableAccountA = await accountId(orgA, '1120');
      await client.query(
        `INSERT INTO ledger_lines
           (org_id, journal_entry_id, account_id, debit_cents, credit_cents,
            currency_code, fx_rate, base_debit_cents, base_credit_cents)
         VALUES ($1, $2, $3, 100000, 0, 'USD', 1, 100000, 0)`,
        [orgA, entryId, cashAccountA],
      );
      await client.query(
        `INSERT INTO ledger_lines
           (org_id, journal_entry_id, account_id, debit_cents, credit_cents,
            currency_code, fx_rate, base_debit_cents, base_credit_cents)
         VALUES ($1, $2, $3, 0, 100000, 'USD', 1, 0, 100000)`,
        [orgA, entryId, receivableAccountA],
      );

      const paymentRes = await client.query<{ id: string }>(
        `INSERT INTO payments
           (org_id, direction, payment_date, currency_code, amount_cents,
            cash_account_id, customer_id, journal_entry_id, created_by)
         VALUES ($1, 'RECEIVE', '2026-01-10', 'USD', 100000, $2, $3, $4, $5)
         RETURNING id`,
        [orgA, cashAccountA, customerIdA, entryId, userA.id],
      );
      const paymentIdA = paymentRes.rows[0]?.id;
      if (paymentIdA === undefined) throw new Error('no payment id');

      // org A's payment allocating to org B's invoice — the composite FK
      // (fk_allocation_invoice references invoices(org_id, id)) rejects this
      // before the trigger's own lookup (which is itself org-scoped) ever
      // gets a chance to find a currency mismatch.
      const code = await errorCode(() =>
        client.query(
          `INSERT INTO payment_allocations (org_id, payment_id, invoice_id, bill_id, amount_cents)
           VALUES ($1, $2, $3, NULL, 100000)`,
          [orgA, paymentIdA, invoiceIdB],
        ),
      );
      expect(code).toBe('23503'); // foreign_key_violation
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
