import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * The database as the guardrail, not the application — the bank
 * reconciliation half of ledgerConstraints.test.ts / paymentConstraints.test.ts.
 * Every test here goes around bankImportService/bankMatchService, straight
 * at the pool, proving migration 019's constraints and triggers hold
 * regardless of what wrote the row.
 */

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const FEATURE_NOT_SUPPORTED = '0A000';

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

async function accountId(org: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [org, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code}`);
  return row.id;
}

/** A committed, balanced two-line journal entry — unrelated to the triggers under test. */
async function insertBalancedEntry(
  org: string,
  createdBy: string,
  debitCode: string,
  creditCode: string,
  amountCents: number,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries (org_id, created_by, entry_date, description)
       VALUES ($1, $2, '2026-07-01', 'raw sql fixture') RETURNING id`,
      [org, createdBy],
    );
    const entryId = rows[0]?.id;
    if (entryId === undefined) throw new Error('no entry id');

    await client.query(
      `INSERT INTO ledger_lines (org_id, journal_entry_id, account_id, debit_cents, credit_cents, currency_code, fx_rate, base_debit_cents, base_credit_cents)
       VALUES ($1, $2, $3, $4, 0, 'USD', 1, $4, 0)`,
      [org, entryId, await accountId(org, debitCode), amountCents],
    );
    await client.query(
      `INSERT INTO ledger_lines (org_id, journal_entry_id, account_id, debit_cents, credit_cents, currency_code, fx_rate, base_debit_cents, base_credit_cents)
       VALUES ($1, $2, $3, 0, $4, 'USD', 1, 0, $4)`,
      [org, entryId, await accountId(org, creditCode), amountCents],
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

async function insertCustomer(org: string, createdBy: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO customers (org_id, created_by, name) VALUES ($1, $2, 'Raw SQL Co') RETURNING id`,
    [org, createdBy],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no customer id');
  return row.id;
}

async function insertIssuedInvoice(org: string, createdBy: string, customerId: string, totalCents: number): Promise<string> {
  const journalEntryId = await insertBalancedEntry(org, createdBy, '1120', '4100', totalCents);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO invoices
       (org_id, customer_id, invoice_number, status, issue_date, due_date, currency_code,
        customer_name_snapshot, subtotal_cents, tax_cents, total_cents, journal_entry_id, issued_at, created_by)
     VALUES ($1, $2, 'INV-RAW-001', 'ISSUED', '2026-06-01', '2026-12-31', 'USD', 'Raw SQL Co',
             $3, 0, $3, $4, now(), $5)
     RETURNING id`,
    [org, customerId, totalCents, journalEntryId, createdBy],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no invoice id');
  return row.id;
}

/** A POSTED payment row with a matching allocation, inserted directly. */
async function insertPostedPayment(
  org: string,
  createdBy: string,
  cashAccountId: string,
  customerId: string,
  invoiceId: string,
  amountCents: number,
): Promise<string> {
  const journalEntryId = await insertBalancedEntry(org, createdBy, '1110', '1120', amountCents);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO payments
         (org_id, direction, payment_date, currency_code, amount_cents, cash_account_id,
          customer_id, journal_entry_id, created_by)
       VALUES ($1, 'RECEIVE', '2026-07-01', 'USD', $2, $3, $4, $5, $6)
       RETURNING id`,
      [org, amountCents, cashAccountId, customerId, journalEntryId, createdBy],
    );
    const paymentId = rows[0]?.id;
    if (paymentId === undefined) throw new Error('no payment id');
    await client.query(
      `INSERT INTO payment_allocations (org_id, payment_id, invoice_id, amount_cents) VALUES ($1, $2, $3, $4)`,
      [org, paymentId, invoiceId, amountCents],
    );
    await client.query('COMMIT');
    return paymentId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function dedupeHash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

async function insertImport(org: string, createdBy: string, accountIdValue: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO bank_statement_imports (org_id, account_id, file_name, date_format, delimiter, created_by)
     VALUES ($1, $2, 'statement.csv', 'ISO', ',', $3)
     RETURNING id`,
    [org, accountIdValue, createdBy],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no import id');
  return row.id;
}

interface BankTxnOverrides {
  amountCents?: number;
  dedupeSeed?: string;
  status?: string;
  matchedPaymentId?: string | null;
  matchedBy?: string | null;
}

async function insertBankTransaction(
  org: string,
  importId: string,
  accountIdValue: string,
  overrides: BankTxnOverrides = {},
): Promise<string> {
  const amountCents = overrides.amountCents ?? 5000;
  const seed = overrides.dedupeSeed ?? `${org}|${importId}|${String(amountCents)}|${Math.random().toString(36)}`;
  const status = overrides.status ?? 'UNMATCHED';
  const matchedPaymentId = overrides.matchedPaymentId ?? null;
  const matchedBy = overrides.matchedBy ?? null;
  const matchedAt = status === 'MATCHED' ? new Date() : null;

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO bank_transactions
       (org_id, import_id, account_id, txn_date, description, currency_code, amount_cents,
        dedupe_hash, status, matched_payment_id, matched_at, matched_by)
     VALUES ($1, $2, $3, '2026-07-01', 'Raw SQL Deposit', 'USD', $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [org, importId, accountIdValue, amountCents, dedupeHash(seed), status, matchedPaymentId, matchedAt, matchedBy],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no bank transaction id');
  return row.id;
}

beforeEach(async () => {
  await resetTables();
  user = await createUserWithOrg({ label: 'bankraw', orgName: 'Bank Raw SQL Org' });
  orgId = user.orgId;
});

afterAll(closePool);

describe('bank_transactions dedupe', () => {
  it('rejects a second bank line with the same (org_id, dedupe_hash)', async () => {
    const cashAccountId = await accountId(orgId, '1110');
    const importId = await insertImport(orgId, user.id, cashAccountId);
    const seed = 'shared-seed';
    await insertBankTransaction(orgId, importId, cashAccountId, { dedupeSeed: seed });

    const code = await errorCode(() => insertBankTransaction(orgId, importId, cashAccountId, { dedupeSeed: seed }));
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('allows the same dedupe_hash in a different organization', async () => {
    const cashAccountId = await accountId(orgId, '1110');
    const importId = await insertImport(orgId, user.id, cashAccountId);
    const seed = 'shared-across-orgs';
    await insertBankTransaction(orgId, importId, cashAccountId, { dedupeSeed: seed });

    const otherOrg = await createUserWithOrg({ label: 'bankraw2', orgName: 'Bank Raw SQL Org 2' });
    const otherCashAccountId = await accountId(otherOrg.orgId, '1110');
    const otherImportId = await insertImport(otherOrg.orgId, otherOrg.id, otherCashAccountId);

    const secondId = await insertBankTransaction(otherOrg.orgId, otherImportId, otherCashAccountId, {
      dedupeSeed: seed,
    });
    expect(secondId).toBeTruthy();
  });
});

describe('bank_transactions CHECK constraints', () => {
  it('rejects a zero amount', async () => {
    const cashAccountId = await accountId(orgId, '1110');
    const importId = await insertImport(orgId, user.id, cashAccountId);
    const code = await errorCode(() => insertBankTransaction(orgId, importId, cashAccountId, { amountCents: 0 }));
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('rejects MATCHED without a payment id', async () => {
    const cashAccountId = await accountId(orgId, '1110');
    const importId = await insertImport(orgId, user.id, cashAccountId);
    const code = await errorCode(() =>
      insertBankTransaction(orgId, importId, cashAccountId, { status: 'MATCHED' }),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('rejects UNMATCHED carrying a payment id', async () => {
    const cashAccountId = await accountId(orgId, '1110');
    const importId = await insertImport(orgId, user.id, cashAccountId);
    const customerId = await insertCustomer(orgId, user.id);
    const invoiceId = await insertIssuedInvoice(orgId, user.id, customerId, 5000);
    const paymentId = await insertPostedPayment(orgId, user.id, cashAccountId, customerId, invoiceId, 5000);

    const code = await errorCode(() =>
      insertBankTransaction(orgId, importId, cashAccountId, {
        status: 'UNMATCHED',
        matchedPaymentId: paymentId,
        matchedBy: user.id,
      }),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });
});

describe('bank_transactions immutability', () => {
  it('rejects a DELETE of a bank transaction', async () => {
    const cashAccountId = await accountId(orgId, '1110');
    const importId = await insertImport(orgId, user.id, cashAccountId);
    const txnId = await insertBankTransaction(orgId, importId, cashAccountId);

    const code = await errorCode(() => pool.query('DELETE FROM bank_transactions WHERE id = $1', [txnId]));
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('rejects changing the amount of a bank transaction', async () => {
    const cashAccountId = await accountId(orgId, '1110');
    const importId = await insertImport(orgId, user.id, cashAccountId);
    const txnId = await insertBankTransaction(orgId, importId, cashAccountId);

    const code = await errorCode(() =>
      pool.query('UPDATE bank_transactions SET amount_cents = 999 WHERE id = $1', [txnId]),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('permits changing only the match fields', async () => {
    const cashAccountId = await accountId(orgId, '1110');
    const importId = await insertImport(orgId, user.id, cashAccountId);
    const txnId = await insertBankTransaction(orgId, importId, cashAccountId);

    await pool.query(`UPDATE bank_transactions SET status = 'IGNORED' WHERE id = $1`, [txnId]);

    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM bank_transactions WHERE id = $1',
      [txnId],
    );
    expect(rows[0]?.status).toBe('IGNORED');
  });
});

describe('bank reconciliation composite FKs', () => {
  it("rejects an import row pointing at another organization's account", async () => {
    const otherOrg = await createUserWithOrg({ label: 'bankraw3', orgName: 'Bank Raw SQL Org 3' });
    const foreignAccountId = await accountId(otherOrg.orgId, '1110');

    const code = await errorCode(() => insertImport(orgId, user.id, foreignAccountId));
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("rejects a suggestion pointing at another organization's invoice", async () => {
    const cashAccountId = await accountId(orgId, '1110');
    const importId = await insertImport(orgId, user.id, cashAccountId);
    const txnId = await insertBankTransaction(orgId, importId, cashAccountId);

    const otherOrg = await createUserWithOrg({ label: 'bankraw4', orgName: 'Bank Raw SQL Org 4' });
    const otherCustomerId = await insertCustomer(otherOrg.orgId, otherOrg.id);
    const foreignInvoiceId = await insertIssuedInvoice(otherOrg.orgId, otherOrg.id, otherCustomerId, 5000);

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO bank_match_suggestions (org_id, bank_transaction_id, target_type, invoice_id, score, score_breakdown)
         VALUES ($1, $2, 'invoice', $3, 80, '{}'::jsonb)`,
        [orgId, txnId, foreignInvoiceId],
      ),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('rejects a suggestion naming both an invoice and a bill', async () => {
    const cashAccountId = await accountId(orgId, '1110');
    const importId = await insertImport(orgId, user.id, cashAccountId);
    const txnId = await insertBankTransaction(orgId, importId, cashAccountId);
    const customerId = await insertCustomer(orgId, user.id);
    const invoiceId = await insertIssuedInvoice(orgId, user.id, customerId, 5000);

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO bank_match_suggestions (org_id, bank_transaction_id, target_type, invoice_id, bill_id, score, score_breakdown)
         VALUES ($1, $2, 'invoice', $3, $3, 80, '{}'::jsonb)`,
        [orgId, txnId, invoiceId],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });
});

describe('bank reconciliation audit trail', () => {
  it('writes an audit row for a bank transaction insert', async () => {
    const cashAccountId = await accountId(orgId, '1110');
    const importId = await insertImport(orgId, user.id, cashAccountId);
    const txnId = await insertBankTransaction(orgId, importId, cashAccountId);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM audit_logs
        WHERE table_name = 'bank_transactions' AND operation = 'INSERT' AND row_id = $1 AND app_slug = 'ledger-core'`,
      [txnId],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('writes no audit row for a suggestion insert', async () => {
    const cashAccountId = await accountId(orgId, '1110');
    const importId = await insertImport(orgId, user.id, cashAccountId);
    const txnId = await insertBankTransaction(orgId, importId, cashAccountId);
    const customerId = await insertCustomer(orgId, user.id);
    const invoiceId = await insertIssuedInvoice(orgId, user.id, customerId, 5000);

    await pool.query(
      `INSERT INTO bank_match_suggestions (org_id, bank_transaction_id, target_type, invoice_id, score, score_breakdown)
       VALUES ($1, $2, 'invoice', $3, 80, '{}'::jsonb)`,
      [orgId, txnId, invoiceId],
    );

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM audit_logs WHERE table_name = 'bank_match_suggestions'`,
    );
    expect(rows[0]?.count).toBe('0');
  });
});
