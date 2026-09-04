import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * The database as the guardrail, not the application — the payment half of
 * ledgerConstraints.test.ts. Every test here goes around `paymentService`,
 * straight at the pool, proving migration 014's deferred constraint triggers
 * and immutability triggers hold regardless of what wrote the row.
 */

const RAISE_EXCEPTION = 'P0001';
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

/** A committed, balanced two-line journal entry — its own transaction, unrelated to the payment triggers under test. */
async function insertBalancedEntry(debitCode: string, creditCode: string, amountCents: number): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries (org_id, created_by, entry_date, description)
       VALUES ($1, $2, '2026-07-01', 'raw sql fixture') RETURNING id`,
      [orgId, user.id],
    );
    const entryId = rows[0]?.id;
    if (entryId === undefined) throw new Error('no entry id');

    await client.query(
      `INSERT INTO ledger_lines (org_id, journal_entry_id, account_id, debit_cents, credit_cents, currency_code, fx_rate, base_debit_cents, base_credit_cents)
       VALUES ($1, $2, $3, $4, 0, 'USD', 1, $4, 0)`,
      [orgId, entryId, await accountId(debitCode), amountCents],
    );
    await client.query(
      `INSERT INTO ledger_lines (org_id, journal_entry_id, account_id, debit_cents, credit_cents, currency_code, fx_rate, base_debit_cents, base_credit_cents)
       VALUES ($1, $2, $3, 0, $4, 'USD', 1, 0, $4)`,
      [orgId, entryId, await accountId(creditCode), amountCents],
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

async function insertCustomer(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO customers (org_id, created_by, name) VALUES ($1, $2, 'Raw SQL Co') RETURNING id`,
    [orgId, user.id],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no customer id');
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

/** An ISSUED invoice, its own committed fixture — chk_invoices_issued_complete is a plain per-row CHECK, so this succeeds immediately. */
async function insertIssuedInvoice(customerId: string, totalCents: number): Promise<string> {
  const journalEntryId = await insertBalancedEntry('1120', '4100', totalCents);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO invoices
       (org_id, customer_id, invoice_number, status, issue_date, due_date, currency_code,
        customer_name_snapshot, subtotal_cents, tax_cents, total_cents, journal_entry_id, issued_at, created_by)
     VALUES ($1, $2, 'INV-RAW-001', 'ISSUED', '2026-06-01', '2026-12-31', 'USD', 'Raw SQL Co',
             $3, 0, $3, $4, now(), $5)
     RETURNING id`,
    [orgId, customerId, totalCents, journalEntryId, user.id],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no invoice id');
  return row.id;
}

/** A POSTED bill, its own committed fixture. */
async function insertPostedBill(vendorId: string, totalCents: number): Promise<string> {
  const journalEntryId = await insertBalancedEntry('6130', '2100', totalCents);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO bills
       (org_id, vendor_id, vendor_reference, status, bill_date, due_date, currency_code,
        vendor_name_snapshot, subtotal_cents, tax_cents, total_cents, journal_entry_id, posted_at, approved_by, created_by)
     VALUES ($1, $2, 'RAW-BILL-001', 'POSTED', '2026-06-01', '2026-12-31', 'USD', 'Raw SQL Vendor',
             $3, 0, $3, $4, now(), $5, $5)
     RETURNING id`,
    [orgId, vendorId, totalCents, journalEntryId, user.id],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no bill id');
  return row.id;
}

/** A POSTED payment row, inserted directly — bypasses paymentService. Caller inserts its own allocations. */
async function insertPaymentRow(
  client: { query: typeof pool.query },
  args: { direction: 'RECEIVE' | 'PAY'; amountCents: number; cashAccountId: string; customerId?: string; vendorId?: string; journalEntryId: string },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO payments
       (org_id, direction, payment_date, currency_code, amount_cents, cash_account_id,
        customer_id, vendor_id, journal_entry_id, created_by)
     VALUES ($1, $2, '2026-07-01', 'USD', $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      orgId,
      args.direction,
      args.amountCents,
      args.cashAccountId,
      args.customerId ?? null,
      args.vendorId ?? null,
      args.journalEntryId,
      user.id,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no payment id');
  return row.id;
}

beforeEach(async () => {
  await resetTables();
  user = await createUserWithOrg({ label: 'raw', orgName: 'Raw SQL Org' });
  orgId = user.orgId;
});

afterAll(closePool);

describe('payment allocation completeness is deferred to COMMIT', () => {
  it('accepts a payment with no allocations mid-transaction, then rejects at COMMIT', async () => {
    const customerId = await insertCustomer();
    const invoiceId = await insertIssuedInvoice(customerId, 100000);
    const cashAccountId = await accountId('1110');
    const journalEntryId = await insertBalancedEntry('1110', '1120', 40000);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Must succeed: the deferred trigger has not fired yet.
      await insertPaymentRow(client, {
        direction: 'RECEIVE',
        amountCents: 40000,
        cashAccountId,
        customerId,
        journalEntryId,
      });

      const code = await errorCode(() => client.query('COMMIT'));
      expect(code).toBe(RAISE_EXCEPTION);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM payments WHERE org_id = $1',
      [orgId],
    );
    expect(rows[0]?.count).toBe('0');
    void invoiceId;
  });

  it('rejects at COMMIT when allocations do not sum to the payment amount', async () => {
    const customerId = await insertCustomer();
    const invoiceId = await insertIssuedInvoice(customerId, 100000);
    const cashAccountId = await accountId('1110');
    const journalEntryId = await insertBalancedEntry('1110', '1120', 40000);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const paymentId = await insertPaymentRow(client, {
        direction: 'RECEIVE',
        amountCents: 40000,
        cashAccountId,
        customerId,
        journalEntryId,
      });
      await client.query(
        `INSERT INTO payment_allocations (org_id, payment_id, invoice_id, amount_cents) VALUES ($1, $2, $3, 20000)`,
        [orgId, paymentId, invoiceId],
      );

      const code = await errorCode(() => client.query('COMMIT'));
      expect(code).toBe(RAISE_EXCEPTION);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('succeeds when allocations sum to the payment amount', async () => {
    const customerId = await insertCustomer();
    const invoiceId = await insertIssuedInvoice(customerId, 100000);
    const cashAccountId = await accountId('1110');
    const journalEntryId = await insertBalancedEntry('1110', '1120', 40000);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const paymentId = await insertPaymentRow(client, {
        direction: 'RECEIVE',
        amountCents: 40000,
        cashAccountId,
        customerId,
        journalEntryId,
      });
      await client.query(
        `INSERT INTO payment_allocations (org_id, payment_id, invoice_id, amount_cents) VALUES ($1, $2, $3, 40000)`,
        [orgId, paymentId, invoiceId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM payments WHERE org_id = $1',
      [orgId],
    );
    expect(rows[0]?.count).toBe('1');
  });
});

describe('overallocation is rejected at COMMIT', () => {
  it('rejects a second payment whose allocation would exceed the document total', async () => {
    const customerId = await insertCustomer();
    const invoiceId = await insertIssuedInvoice(customerId, 100000);
    const cashAccountId = await accountId('1110');

    // First payment: 60000 — succeeds outright.
    const firstEntry = await insertBalancedEntry('1110', '1120', 60000);
    const firstClient = await pool.connect();
    try {
      await firstClient.query('BEGIN');
      const paymentId = await insertPaymentRow(firstClient, {
        direction: 'RECEIVE',
        amountCents: 60000,
        cashAccountId,
        customerId,
        journalEntryId: firstEntry,
      });
      await firstClient.query(
        `INSERT INTO payment_allocations (org_id, payment_id, invoice_id, amount_cents) VALUES ($1, $2, $3, 60000)`,
        [orgId, paymentId, invoiceId],
      );
      await firstClient.query('COMMIT');
    } finally {
      firstClient.release();
    }

    // Second payment: another 60000 against the same 100000 invoice — total would be 120000.
    const secondEntry = await insertBalancedEntry('1110', '1120', 60000);
    const secondClient = await pool.connect();
    try {
      await secondClient.query('BEGIN');
      const paymentId = await insertPaymentRow(secondClient, {
        direction: 'RECEIVE',
        amountCents: 60000,
        cashAccountId,
        customerId,
        journalEntryId: secondEntry,
      });
      await secondClient.query(
        `INSERT INTO payment_allocations (org_id, payment_id, invoice_id, amount_cents) VALUES ($1, $2, $3, 60000)`,
        [orgId, paymentId, invoiceId],
      );

      const code = await errorCode(() => secondClient.query('COMMIT'));
      expect(code).toBe(RAISE_EXCEPTION);
    } finally {
      await secondClient.query('ROLLBACK').catch(() => undefined);
      secondClient.release();
    }
  });
});

describe('payment immutability, enforced by the database', () => {
  it('UPDATE on amount_cents raises 0A000', async () => {
    const customerId = await insertCustomer();
    const invoiceId = await insertIssuedInvoice(customerId, 100000);
    const cashAccountId = await accountId('1110');
    const journalEntryId = await insertBalancedEntry('1110', '1120', 40000);

    const paymentId = await pool.connect().then(async (client) => {
      try {
        await client.query('BEGIN');
        const id = await insertPaymentRow(client, {
          direction: 'RECEIVE',
          amountCents: 40000,
          cashAccountId,
          customerId,
          journalEntryId,
        });
        await client.query(
          `INSERT INTO payment_allocations (org_id, payment_id, invoice_id, amount_cents) VALUES ($1, $2, $3, 40000)`,
          [orgId, id, invoiceId],
        );
        await client.query('COMMIT');
        return id;
      } finally {
        client.release();
      }
    });

    const code = await errorCode(() =>
      pool.query('UPDATE payments SET amount_cents = 1 WHERE id = $1', [paymentId]),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('DELETE raises 0A000', async () => {
    const customerId = await insertCustomer();
    const invoiceId = await insertIssuedInvoice(customerId, 100000);
    const cashAccountId = await accountId('1110');
    const journalEntryId = await insertBalancedEntry('1110', '1120', 40000);

    const paymentId = await pool.connect().then(async (client) => {
      try {
        await client.query('BEGIN');
        const id = await insertPaymentRow(client, {
          direction: 'RECEIVE',
          amountCents: 40000,
          cashAccountId,
          customerId,
          journalEntryId,
        });
        await client.query(
          `INSERT INTO payment_allocations (org_id, payment_id, invoice_id, amount_cents) VALUES ($1, $2, $3, 40000)`,
          [orgId, id, invoiceId],
        );
        await client.query('COMMIT');
        return id;
      } finally {
        client.release();
      }
    });

    const code = await errorCode(() => pool.query('DELETE FROM payments WHERE id = $1', [paymentId]));
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('the POSTED -> VOID update is allowed', async () => {
    const customerId = await insertCustomer();
    const invoiceId = await insertIssuedInvoice(customerId, 100000);
    const cashAccountId = await accountId('1110');
    const journalEntryId = await insertBalancedEntry('1110', '1120', 40000);

    const paymentId = await pool.connect().then(async (client) => {
      try {
        await client.query('BEGIN');
        const id = await insertPaymentRow(client, {
          direction: 'RECEIVE',
          amountCents: 40000,
          cashAccountId,
          customerId,
          journalEntryId,
        });
        await client.query(
          `INSERT INTO payment_allocations (org_id, payment_id, invoice_id, amount_cents) VALUES ($1, $2, $3, 40000)`,
          [orgId, id, invoiceId],
        );
        await client.query('COMMIT');
        return id;
      } finally {
        client.release();
      }
    });

    await pool.query(
      `UPDATE payments SET status = 'VOID', voided_at = now(), void_journal_entry_id = NULL WHERE id = $1`,
      [paymentId],
    );

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM payments WHERE id = $1', [
      paymentId,
    ]);
    expect(rows[0]?.status).toBe('VOID');
  });

  it('a POSTED -> VOID update that also changes another field raises 0A000', async () => {
    const customerId = await insertCustomer();
    const invoiceId = await insertIssuedInvoice(customerId, 100000);
    const cashAccountId = await accountId('1110');
    const journalEntryId = await insertBalancedEntry('1110', '1120', 40000);

    const paymentId = await pool.connect().then(async (client) => {
      try {
        await client.query('BEGIN');
        const id = await insertPaymentRow(client, {
          direction: 'RECEIVE',
          amountCents: 40000,
          cashAccountId,
          customerId,
          journalEntryId,
        });
        await client.query(
          `INSERT INTO payment_allocations (org_id, payment_id, invoice_id, amount_cents) VALUES ($1, $2, $3, 40000)`,
          [orgId, id, invoiceId],
        );
        await client.query('COMMIT');
        return id;
      } finally {
        client.release();
      }
    });

    const code = await errorCode(() =>
      pool.query(`UPDATE payments SET status = 'VOID', reference = 'x' WHERE id = $1`, [paymentId]),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('UPDATE on a payment_allocations row raises 0A000', async () => {
    const customerId = await insertCustomer();
    const invoiceId = await insertIssuedInvoice(customerId, 100000);
    const cashAccountId = await accountId('1110');
    const journalEntryId = await insertBalancedEntry('1110', '1120', 40000);

    const allocationId = await pool.connect().then(async (client) => {
      try {
        await client.query('BEGIN');
        const id = await insertPaymentRow(client, {
          direction: 'RECEIVE',
          amountCents: 40000,
          cashAccountId,
          customerId,
          journalEntryId,
        });
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO payment_allocations (org_id, payment_id, invoice_id, amount_cents) VALUES ($1, $2, $3, 40000) RETURNING id`,
          [orgId, id, invoiceId],
        );
        await client.query('COMMIT');
        return rows[0]?.id;
      } finally {
        client.release();
      }
    });

    const code = await errorCode(() =>
      pool.query('UPDATE payment_allocations SET amount_cents = 1 WHERE id = $1', [allocationId]),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('DELETE on a payment_allocations row raises 0A000', async () => {
    const customerId = await insertCustomer();
    const invoiceId = await insertIssuedInvoice(customerId, 100000);
    const cashAccountId = await accountId('1110');
    const journalEntryId = await insertBalancedEntry('1110', '1120', 40000);

    const allocationId = await pool.connect().then(async (client) => {
      try {
        await client.query('BEGIN');
        const id = await insertPaymentRow(client, {
          direction: 'RECEIVE',
          amountCents: 40000,
          cashAccountId,
          customerId,
          journalEntryId,
        });
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO payment_allocations (org_id, payment_id, invoice_id, amount_cents) VALUES ($1, $2, $3, 40000) RETURNING id`,
          [orgId, id, invoiceId],
        );
        await client.query('COMMIT');
        return rows[0]?.id;
      } finally {
        client.release();
      }
    });

    const code = await errorCode(() =>
      pool.query('DELETE FROM payment_allocations WHERE id = $1', [allocationId]),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });
});

describe('payment CHECK and FK constraints', () => {
  it('a RECEIVE with a non-null vendor_id is rejected', async () => {
    const customerId = await insertCustomer();
    const vendorId = await insertVendor();
    const cashAccountId = await accountId('1110');
    const journalEntryId = await insertBalancedEntry('1110', '1120', 40000);

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO payments (org_id, direction, payment_date, currency_code, amount_cents, cash_account_id, customer_id, vendor_id, journal_entry_id, created_by)
         VALUES ($1, 'RECEIVE', '2026-07-01', 'USD', 40000, $2, $3, $4, $5, $6)`,
        [orgId, cashAccountId, customerId, vendorId, journalEntryId, user.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('an allocation naming both invoice_id and bill_id is rejected', async () => {
    const customerId = await insertCustomer();
    const vendorId = await insertVendor();
    const invoiceId = await insertIssuedInvoice(customerId, 100000);
    const billId = await insertPostedBill(vendorId, 60000);
    const cashAccountId = await accountId('1110');
    const journalEntryId = await insertBalancedEntry('1110', '1120', 40000);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const paymentId = await insertPaymentRow(client, {
        direction: 'RECEIVE',
        amountCents: 40000,
        cashAccountId,
        customerId,
        journalEntryId,
      });
      const code = await errorCode(() =>
        client.query(
          `INSERT INTO payment_allocations (org_id, payment_id, invoice_id, bill_id, amount_cents) VALUES ($1, $2, $3, $4, 40000)`,
          [orgId, paymentId, invoiceId, billId],
        ),
      );
      expect(code).toBe(CHECK_VIOLATION);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('an allocation naming neither invoice_id nor bill_id is rejected', async () => {
    const customerId = await insertCustomer();
    const cashAccountId = await accountId('1110');
    const journalEntryId = await insertBalancedEntry('1110', '1120', 40000);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const paymentId = await insertPaymentRow(client, {
        direction: 'RECEIVE',
        amountCents: 40000,
        cashAccountId,
        customerId,
        journalEntryId,
      });
      const code = await errorCode(() =>
        client.query(
          `INSERT INTO payment_allocations (org_id, payment_id, amount_cents) VALUES ($1, $2, 40000)`,
          [orgId, paymentId],
        ),
      );
      expect(code).toBe(CHECK_VIOLATION);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it("a payment cannot reference another org's cash account", async () => {
    const otherOrg = await createUserWithOrg({ label: 'other', orgName: 'Other Org' });
    const { rows: foreignAccountRows } = await pool.query<{ id: string }>(
      "SELECT id FROM accounts WHERE org_id = $1 AND code = '1110'",
      [otherOrg.orgId],
    );
    const foreignAccountId = foreignAccountRows[0]?.id;
    if (foreignAccountId === undefined) throw new Error('no foreign account id');

    const customerId = await insertCustomer();
    const journalEntryId = await insertBalancedEntry('1110', '1120', 40000);

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO payments (org_id, direction, payment_date, currency_code, amount_cents, cash_account_id, customer_id, journal_entry_id, created_by)
         VALUES ($1, 'RECEIVE', '2026-07-01', 'USD', 40000, $2, $3, $4, $5)`,
        [orgId, foreignAccountId, customerId, journalEntryId, user.id],
      ),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("a payment_allocations row cannot reference another org's invoice", async () => {
    const otherOrg = await createUserWithOrg({ label: 'other2', orgName: 'Other Org 2' });
    const { rows: foreignCustomerRows } = await pool.query<{ id: string }>(
      `INSERT INTO customers (org_id, created_by, name) VALUES ($1, $2, 'Foreign Co') RETURNING id`,
      [otherOrg.orgId, otherOrg.id],
    );
    const foreignCustomerId = foreignCustomerRows[0]?.id;
    if (foreignCustomerId === undefined) throw new Error('no foreign customer id');

    const savedOrgId = orgId;
    const savedUser = user;
    orgId = otherOrg.orgId;
    user = otherOrg;
    const foreignInvoiceId = await insertIssuedInvoice(foreignCustomerId, 50000);
    orgId = savedOrgId;
    user = savedUser;

    const customerId = await insertCustomer();
    const cashAccountId = await accountId('1110');
    const journalEntryId = await insertBalancedEntry('1110', '1120', 40000);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const paymentId = await insertPaymentRow(client, {
        direction: 'RECEIVE',
        amountCents: 40000,
        cashAccountId,
        customerId,
        journalEntryId,
      });
      const code = await errorCode(() =>
        client.query(
          `INSERT INTO payment_allocations (org_id, payment_id, invoice_id, amount_cents) VALUES ($1, $2, $3, 40000)`,
          [orgId, paymentId, foreignInvoiceId],
        ),
      );
      expect(code).toBe(FOREIGN_KEY_VIOLATION);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
