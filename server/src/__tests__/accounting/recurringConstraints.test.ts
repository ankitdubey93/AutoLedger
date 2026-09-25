import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * The database as the guardrail, not the application — migration 075's
 * constraints and the recurring_runs append-only trigger, proven straight
 * against the pool regardless of what wrote the row (mirrors
 * bankRuleConstraints.test.ts for Phase 34a).
 */

const app = createApp();
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
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
type Agent = Awaited<ReturnType<typeof loginAgent>>;
let agent: Agent;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function accountId(org: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [org, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code}`);
  return row.id;
}

async function createDraftInvoice(): Promise<string> {
  const customerRes = await agent.post('/api/v1/customers').send({ name: 'Northwind Traders' });
  const customerId = customerRes.body.customer.id as string;
  const revenueAccountId = await accountId(orgId, '4100');
  const res = await agent.post('/api/v1/invoices').send({
    customerId,
    issueDate: today(),
    dueDate: today(),
    lines: [
      { description: 'Consulting', quantityMilli: 1000, unitPriceCents: 10000, revenueAccountId },
    ],
  });
  if (res.status !== 201) throw new Error(`fixture: invoice failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.invoice.id as string;
}

async function createDraftBill(): Promise<string> {
  const vendorRes = await agent.post('/api/v1/vendors').send({ name: 'Acme Supplies' });
  const vendorId = vendorRes.body.vendor.id as string;
  const expenseAccountId = await accountId(orgId, '6120');
  const res = await agent.post('/api/v1/bills').send({
    vendorId,
    vendorReference: 'INV-100',
    billDate: today(),
    dueDate: today(),
    lines: [
      { description: 'Supplies', quantityMilli: 1000, unitPriceCents: 20000, expenseAccountId },
    ],
  });
  if (res.status !== 201) throw new Error(`fixture: bill failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.bill.id as string;
}

async function createManualJournal(): Promise<string> {
  const expenseAccountId = await accountId(orgId, '6120');
  const creditAccountId = await accountId(orgId, '2120');
  const res = await agent.post('/api/v1/journals').send({
    entryDate: today(),
    description: 'Rent',
    lines: [
      { accountId: expenseAccountId, debitCents: 5000, creditCents: 0 },
      { accountId: creditAccountId, debitCents: 0, creditCents: 5000 },
    ],
  });
  if (res.status !== 201) throw new Error(`fixture: journal failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.entry.id as string;
}

/** A valid, ACTIVE INVOICE-kind schedule row — the FK target for recurring_runs fixtures. */
async function insertSchedule(
  org: string,
  createdBy: string,
  sourceInvoiceId: string,
  overrides: { status?: string; nextRunDate?: string | null } = {},
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO recurring_schedules
       (org_id, kind, name, source_invoice_id, frequency, start_date, next_run_date, mode, status, created_by)
     VALUES ($1, 'INVOICE', 'Raw SQL schedule', $2, 'MONTHLY', $3, $4, 'DRAFT', $5, $6)
     RETURNING id`,
    [
      org,
      sourceInvoiceId,
      today(),
      overrides.nextRunDate === undefined ? today() : overrides.nextRunDate,
      overrides.status ?? 'ACTIVE',
      createdBy,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no schedule id');
  return row.id;
}

async function insertRun(
  org: string,
  scheduleId: string,
  runDate: string,
  occurrenceNumber: number,
  documentIds: { invoiceId?: string; billId?: string },
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO recurring_runs (org_id, schedule_id, run_date, occurrence_number, invoice_id, bill_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [org, scheduleId, runDate, occurrenceNumber, documentIds.invoiceId ?? null, documentIds.billId ?? null],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no run id');
  return row.id;
}

beforeEach(async () => {
  await resetTables();
  user = await createUserWithOrg({ label: 'recurringraw', orgName: 'Recurring Raw SQL Org' });
  orgId = user.orgId;
  agent = await loginAgent(app, user);
});

afterAll(closePool);

describe('recurring_schedules CHECK constraints', () => {
  it("chk_recurring_source_matches_kind rejects kind 'INVOICE' with a bill source", async () => {
    const billId = await createDraftBill();
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO recurring_schedules
           (org_id, kind, name, source_bill_id, frequency, start_date, next_run_date, mode, created_by)
         VALUES ($1, 'INVOICE', 'Bad schedule', $2, 'MONTHLY', $3, $3, 'DRAFT', $4)`,
        [orgId, billId, today(), user.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('chk_recurring_journal_posts rejects JOURNAL + DRAFT', async () => {
    const entryId = await createManualJournal();
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO recurring_schedules
           (org_id, kind, name, source_journal_entry_id, frequency, start_date, next_run_date, mode, created_by)
         VALUES ($1, 'JOURNAL', 'Bad schedule', $2, 'MONTHLY', $3, $3, 'DRAFT', $4)`,
        [orgId, entryId, today(), user.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('chk_recurring_ended_has_no_next rejects ENDED with a next_run_date', async () => {
    const invoiceId = await createDraftInvoice();
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO recurring_schedules
           (org_id, kind, name, source_invoice_id, frequency, start_date, next_run_date, mode, status, created_by)
         VALUES ($1, 'INVOICE', 'Bad schedule', $2, 'MONTHLY', $3, $3, 'DRAFT', 'ENDED', $4)`,
        [orgId, invoiceId, today(), user.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });
});

describe('recurring_runs constraints and append-only trigger', () => {
  it('ux_recurring_runs_schedule_date rejects a second run row for the same date', async () => {
    const invoiceId = await createDraftInvoice();
    const scheduleId = await insertSchedule(orgId, user.id, invoiceId);
    await insertRun(orgId, scheduleId, today(), 1, { invoiceId });

    const secondInvoiceId = await createDraftInvoice();
    const code = await errorCode(() => insertRun(orgId, scheduleId, today(), 2, { invoiceId: secondInvoiceId }));
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('recurring_runs rejects UPDATE', async () => {
    const invoiceId = await createDraftInvoice();
    const scheduleId = await insertSchedule(orgId, user.id, invoiceId);
    const runId = await insertRun(orgId, scheduleId, today(), 1, { invoiceId });

    const code = await errorCode(() =>
      pool.query('UPDATE recurring_runs SET occurrence_number = 2 WHERE id = $1', [runId]),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('chk_recurring_runs_one_document rejects a row with both invoice_id and bill_id', async () => {
    const invoiceId = await createDraftInvoice();
    const billId = await createDraftBill();
    const scheduleId = await insertSchedule(orgId, user.id, invoiceId);

    const code = await errorCode(() => insertRun(orgId, scheduleId, today(), 1, { invoiceId, billId }));
    expect(code).toBe(CHECK_VIOLATION);
  });
});
