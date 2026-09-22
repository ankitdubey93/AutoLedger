import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * The database as the guardrail for credit notes (Phase 26). Fixtures are
 * built through the real API; every assertion then goes around
 * `creditNoteService`, straight at the pool, proving migration 063's
 * triggers and CHECKs hold regardless of what wrote the row.
 */

const app = createApp();
const CREDIT_NOTES = '/api/v1/ledger-core/credit-notes';
const INVOICES = '/api/v1/ledger-core/invoices';
const CUSTOMERS = '/api/v1/ledger-core/customers';

const FEATURE_NOT_SUPPORTED = '0A000';
const RAISE_EXCEPTION = 'P0001';
const CHECK_VIOLATION = '23514';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let user: SeededUser;
let orgId: string;
let agent: Agent;

async function errorCode(fn: () => Promise<unknown>): Promise<string | undefined> {
  return (await pgError(fn)).code;
}

async function pgError(fn: () => Promise<unknown>): Promise<{ code: string | undefined; message: string }> {
  try {
    await fn();
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && 'message' in err) {
      return {
        code: typeof err.code === 'string' ? err.code : undefined,
        message: typeof err.message === 'string' ? err.message : '',
      };
    }
  }
  return { code: undefined, message: '' };
}

/** Runs `statements` in one transaction on a dedicated client, so deferred triggers fire at its COMMIT. */
async function inTransaction(statements: (client: import('pg').PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await statements(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function accountId(code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code}`);
  return row.id;
}

async function issuedInvoice(customerId: string, unitPriceCents: number): Promise<string> {
  const created = await agent.post(INVOICES).send({
    customerId,
    issueDate: '2026-09-01',
    dueDate: '2026-12-31',
    notes: null,
    paymentTerms: null,
    lines: [
      { description: 'Kits', quantityMilli: 1000, unitPriceCents, revenueAccountId: await accountId('4100'), taxRateBp: 0 },
    ],
  });
  const id = created.body.invoice.id as string;
  await agent.post(`${INVOICES}/${id}/issue`).send({});
  return id;
}

async function note(invoiceId: string, unitPriceCents: number, issue: boolean): Promise<{ id: string; journalEntryId: string | null }> {
  const created = await agent.post(CREDIT_NOTES).send({
    invoiceId,
    issueDate: '2026-09-05',
    reasonCode: 'RETURN',
    reason: null,
    notes: null,
    lines: [
      { description: 'Return', quantityMilli: 1000, unitPriceCents, revenueAccountId: await accountId('4800'), taxRateBp: 0 },
    ],
  });
  if (created.status !== 201) throw new Error(`fixture: note create failed ${created.status} ${created.text}`);
  const id = created.body.creditNote.id as string;
  if (!issue) return { id, journalEntryId: null };
  const issued = await agent.post(`${CREDIT_NOTES}/${id}/issue`).send({});
  if (issued.status !== 200) throw new Error(`fixture: note issue failed ${issued.status} ${issued.text}`);
  return { id, journalEntryId: issued.body.creditNote.journalEntryId as string };
}

let customerId: string;

beforeEach(async () => {
  await resetTables();
  user = await createUserWithOrg({ label: 'dora', orgName: 'Constraint Co' });
  orgId = user.orgId;
  agent = await loginAgent(app, user);
  const res = await agent.post(CUSTOMERS).send({ name: 'Raw SQL Co' });
  customerId = res.body.customer.id as string;
});

afterAll(closePool);

describe('credit notes — immutability', () => {
  it('UPDATE of an issued credit note is rejected', async () => {
    const invoiceId = await issuedInvoice(customerId, 100000);
    const { id } = await note(invoiceId, 22000, true);

    const code = await errorCode(() =>
      pool.query('UPDATE credit_notes SET notes = $1 WHERE id = $2', ['edited', id]),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('DELETE of an issued credit note is rejected', async () => {
    const invoiceId = await issuedInvoice(customerId, 100000);
    const { id } = await note(invoiceId, 22000, true);

    const code = await errorCode(() => pool.query('DELETE FROM credit_notes WHERE id = $1', [id]));
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('inserting a line on an issued credit note is rejected', async () => {
    const invoiceId = await issuedInvoice(customerId, 100000);
    const { id } = await note(invoiceId, 22000, true);
    const accountIdFor4800 = await accountId('4800');

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO credit_note_lines
           (org_id, credit_note_id, line_number, description, quantity_milli, unit_price_cents,
            revenue_account_id, tax_rate_bp, net_cents, tax_cents)
         VALUES ($1, $2, 2, 'Sneaky', 1000, 100, $3, 0, 100, 0)`,
        [orgId, id, accountIdFor4800],
      ),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('credit note allocations are insert-only', async () => {
    const invoiceId = await issuedInvoice(customerId, 100000);
    const { id } = await note(invoiceId, 22000, true);

    const update = await errorCode(() =>
      pool.query('UPDATE credit_note_allocations SET amount_cents = 1 WHERE credit_note_id = $1', [id]),
    );
    expect(update).toBe(FEATURE_NOT_SUPPORTED);

    const del = await errorCode(() =>
      pool.query('DELETE FROM credit_note_allocations WHERE credit_note_id = $1', [id]),
    );
    expect(del).toBe(FEATURE_NOT_SUPPORTED);
  });
});

describe('credit notes — deferred settlement invariants', () => {
  it('a note allocation above the note total fails at COMMIT', async () => {
    const target = await issuedInvoice(customerId, 100000);
    // Issuing auto-applies the whole 22000 to `target`, so any further row over-applies it.
    const { id } = await note(target, 22000, true);
    const otherInvoice = await issuedInvoice(customerId, 100000);

    const error = await pgError(() =>
      inTransaction(async (client) => {
        await client.query(
          `INSERT INTO credit_note_allocations
             (org_id, credit_note_id, invoice_id, amount_cents, base_amount_cents, allocation_date, created_by)
           VALUES ($1, $2, $3, 1, 1, '2026-09-06', $4)`,
          [orgId, id, otherInvoice, user.id],
        );
      }),
    );
    expect(error.code).toBe(RAISE_EXCEPTION);
    expect(error.message).toContain('applies 22001 but its total is 22000');
  });

  it('payments plus applied credits cannot exceed the invoice total', async () => {
    const invoiceId = await issuedInvoice(customerId, 100000);
    await note(invoiceId, 60000, true); // auto-applies 60000 to invoiceId

    // A second note, fully applied to its own invoice, then a raw extra
    // allocation from it onto invoiceId: 60000 + 50000 > 100000 there (and
    // the note itself would be over-applied too — either check must fire).
    const otherInvoice = await issuedInvoice(customerId, 100000);
    const other = await note(otherInvoice, 50000, true);
    const error = await pgError(() =>
      inTransaction(async (client) => {
        await client.query(
          `INSERT INTO credit_note_allocations
             (org_id, credit_note_id, invoice_id, amount_cents, base_amount_cents, allocation_date, created_by)
           VALUES ($1, $2, $3, 50000, 50000, '2026-09-06', $4)`,
          [orgId, other.id, invoiceId, user.id],
        );
      }),
    );
    expect(error.code).toBe(RAISE_EXCEPTION);
    expect(error.message).toMatch(/applies|exceeds document total/);
  });

  it('a payment allocation is refused by the database when credits already settle the invoice', async () => {
    const invoiceId = await issuedInvoice(customerId, 100000);
    await note(invoiceId, 100000, true); // fully credited

    const cashId = await accountId('1110');
    const receivableId = await accountId('1120');
    const error = await pgError(() =>
      inTransaction(async (client) => {
        const { rows: entryRows } = await client.query<{ id: string }>(
          `INSERT INTO journal_entries (org_id, entry_date, description, created_by)
           VALUES ($1, '2026-09-06', 'raw receipt', $2) RETURNING id`,
          [orgId, user.id],
        );
        const entryId = entryRows[0]?.id;
        await client.query(
          `INSERT INTO ledger_lines (org_id, journal_entry_id, account_id, debit_cents, credit_cents,
                                     currency_code, fx_rate, base_debit_cents, base_credit_cents)
           VALUES ($1, $2, $3, 100, 0, 'USD', 1, 100, 0), ($1, $2, $4, 0, 100, 'USD', 1, 0, 100)`,
          [orgId, entryId, cashId, receivableId],
        );
        const { rows: paymentRows } = await client.query<{ id: string }>(
          `INSERT INTO payments (org_id, direction, payment_date, currency_code, amount_cents, base_amount_cents,
                                 cash_account_id, customer_id, journal_entry_id, created_by)
           VALUES ($1, 'RECEIVE', '2026-09-06', 'USD', 100, 100, $2, $3, $4, $5) RETURNING id`,
          [orgId, cashId, customerId, entryId, user.id],
        );
        await client.query(
          `INSERT INTO payment_allocations (org_id, payment_id, invoice_id, amount_cents, base_amount_cents)
           VALUES ($1, $2, $3, 100, 100)`,
          [orgId, paymentRows[0]?.id, invoiceId],
        );
      }),
    );
    expect(error.code).toBe(RAISE_EXCEPTION);
    expect(error.message).toContain('Allocations of 100100 exceed document total of 100000');
  });

  it('two issued notes cannot together exceed the invoice total', async () => {
    const invoiceId = await issuedInvoice(customerId, 100000);
    const issued = await note(invoiceId, 80000, true);
    const draft = await note(invoiceId, 20000, false);

    // Force the draft to 30000 and ISSUED directly — 80000 + 30000 > 100000.
    const error = await pgError(() =>
      inTransaction(async (client) => {
        await client.query(
          `UPDATE credit_notes SET subtotal_cents = 30000, total_cents = 30000 WHERE id = $1`,
          [draft.id],
        );
        await client.query(
          `UPDATE credit_notes
              SET status = 'ISSUED', credit_note_number = 'CN-RAW', journal_entry_id = $1, issued_at = now()
            WHERE id = $2`,
          [issued.journalEntryId, draft.id],
        );
      }),
    );
    expect(error.code).toBe(RAISE_EXCEPTION);
    expect(error.message).toContain('total 110000 but the document total is 100000');
  });

  it('total must equal subtotal plus tax', async () => {
    const invoiceId = await issuedInvoice(customerId, 100000);
    const draft = await note(invoiceId, 20000, false);

    const code = await errorCode(() =>
      pool.query('UPDATE credit_notes SET total_cents = 1 WHERE id = $1', [draft.id]),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });
});
