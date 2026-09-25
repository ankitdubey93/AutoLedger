import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import * as recurringService from '../../services/accounting/recurringService.js';
import { addDays, firstDayOfNextMonth, occurrenceDate } from '../../utils/recurrence.js';

/**
 * Accounting — recurring documents (Phase 34b). Integration tier, real
 * PostgreSQL. Covers exactly-once generation, DRAFT/POST modes for each
 * kind, auto-reverse, pause/resume skip-missed, closed-period rollback, the
 * sweep's own cross-org read (`listDueSchedules`), and this module's own
 * cross-tenant isolation cases (rule 15).
 */

const app = createApp();
const RECURRING = '/api/v1/recurring-schedules';
const INVOICES = '/api/v1/invoices';
const BILLS = '/api/v1/bills';
const JOURNALS = '/api/v1/journals';
const CUSTOMERS = '/api/v1/customers';
const VENDORS = '/api/v1/vendors';
const PERIODS = '/api/v1/fiscal-periods';
const ONBOARDING = '/api/v1/settings/onboarding';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;
let agentA: Agent;
let agentB: Agent;

let revenueAccountId: string; // 4100 — postable Revenue
let expenseAccountId: string; // 6120 — postable Expense, not a control account
let creditAccountId: string; // 2120 — postable Liability, not a control account
let arAccountId: string; // 1120 — the receivable control account
let customerId: string;
let vendorId: string;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function accountId(org: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [org, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${org}`);
  return row.id;
}

interface InvoiceLineFixture {
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  revenueAccountId: string;
  taxRateBp?: number;
}

async function createDraftInvoice(
  agent: Agent,
  custId: string,
  revAccountId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; body: Record<string, unknown> }> {
  const lines: InvoiceLineFixture[] = [
    { description: 'Consulting', quantityMilli: 1000, unitPriceCents: 10000, revenueAccountId: revAccountId },
    { description: 'Extra support', quantityMilli: 2000, unitPriceCents: 5000, revenueAccountId: revAccountId },
  ];
  const res = await agent.post(INVOICES).send({
    customerId: custId,
    issueDate: today(),
    dueDate: addDays(today(), 30),
    lines,
    ...overrides,
  });
  if (res.status !== 201) {
    throw new Error(`fixture: create invoice failed ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { id: res.body.invoice.id as string, body: res.body as Record<string, unknown> };
}

async function createDraftBill(
  agent: Agent,
  vendId: string,
  expAccountId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; body: Record<string, unknown> }> {
  const res = await agent.post(BILLS).send({
    vendorId: vendId,
    vendorReference: 'INV-100',
    billDate: today(),
    dueDate: addDays(today(), 30),
    lines: [
      { description: 'Supplies', quantityMilli: 1000, unitPriceCents: 20000, expenseAccountId: expAccountId },
    ],
    ...overrides,
  });
  if (res.status !== 201) {
    throw new Error(`fixture: create bill failed ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { id: res.body.bill.id as string, body: res.body as Record<string, unknown> };
}

async function createManualJournal(
  agent: Agent,
  debitAccountId: string,
  creditAccountId_: string,
  amountCents = 5000,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; body: Record<string, unknown> }> {
  const res = await agent.post(JOURNALS).send({
    entryDate: today(),
    description: 'Monthly rent',
    lines: [
      { accountId: debitAccountId, debitCents: amountCents, creditCents: 0 },
      { accountId: creditAccountId_, debitCents: 0, creditCents: amountCents },
    ],
    ...overrides,
  });
  if (res.status !== 201) {
    throw new Error(`fixture: create journal failed ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { id: res.body.entry.id as string, body: res.body as Record<string, unknown> };
}

/** Raw-SQL journal entry — bypasses journalService's own control-account guard. */
async function insertRawJournalEntry(
  org: string,
  createdBy: string,
  entryDate: string,
  lines: Array<{ accountId: string; debitCents: number; creditCents: number }>,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries (org_id, created_by, entry_date, description, source_type)
       VALUES ($1, $2, $3, 'raw sql fixture', 'manual') RETURNING id`,
      [org, createdBy, entryDate],
    );
    const entryId = rows[0]?.id;
    if (entryId === undefined) throw new Error('no entry id');
    for (const line of lines) {
      await client.query(
        `INSERT INTO ledger_lines (org_id, journal_entry_id, account_id, debit_cents, credit_cents, currency_code, fx_rate, base_debit_cents, base_credit_cents)
         VALUES ($1, $2, $3, $4, $5, 'USD', 1, $4, $5)`,
        [org, entryId, line.accountId, line.debitCents, line.creditCents],
      );
    }
    await client.query('COMMIT');
    return entryId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function closeTodayPeriod(agent: Agent): Promise<void> {
  const now = today();
  const onboardRes = await agent.post(ONBOARDING).send({
    organizationName: 'Acme Books',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    booksStartDate: `${now.slice(0, 4)}-01-01`,
  });
  if (onboardRes.status !== 200) throw new Error(`fixture: onboarding failed ${onboardRes.status}`);

  const generateRes = await agent.post(`${PERIODS}/generate`).send({ containingDate: now });
  const monthPrefix = now.slice(0, 7);
  const period = (generateRes.body.periods as Array<{ id: string; startsOn: string }>).find((p) =>
    p.startsOn.startsWith(monthPrefix),
  );
  if (period === undefined) throw new Error('fixture: no period covering today');
  const closeRes = await agent.post(`${PERIODS}/${period.id}/close`).send({});
  if (closeRes.status !== 200) throw new Error(`fixture: close failed ${closeRes.status} ${JSON.stringify(closeRes.body)}`);
}

async function getSchedule(agent: Agent, id: string): Promise<Record<string, unknown>> {
  const res = await agent.get(`${RECURRING}/${id}`);
  return res.body.schedule as Record<string, unknown>;
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'recurring-a', orgName: 'Recurring Org A' });
  userB = await createUserWithOrg({ label: 'recurring-b', orgName: 'Recurring Org B' });
  orgA = userA.orgId;
  orgB = userB.orgId;

  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);

  revenueAccountId = await accountId(orgA, '4100');
  expenseAccountId = await accountId(orgA, '6120');
  creditAccountId = await accountId(orgA, '2120');
  arAccountId = await accountId(orgA, '1120');

  const customerRes = await agentA.post(CUSTOMERS).send({ name: 'Northwind Traders' });
  customerId = customerRes.body.customer.id as string;
  const vendorRes = await agentA.post(VENDORS).send({ name: 'Acme Supplies' });
  vendorId = vendorRes.body.vendor.id as string;
});

afterAll(closePool);

describe('invoice schedules', () => {
  it('a DRAFT invoice schedule generates one draft invoice copying the template lines', async () => {
    const template = await createDraftInvoice(agentA, customerId, revenueAccountId);
    const templateInvoice = template.body.invoice as { totalCents: number; lines: unknown[] };

    const createRes = await agentA.post(RECURRING).send({
      kind: 'INVOICE',
      sourceId: template.id,
      name: 'Monthly invoice',
      frequency: 'MONTHLY',
      startDate: today(),
    });
    expect(createRes.status).toBe(201);
    const scheduleId = createRes.body.schedule.id as string;

    const runRes = await agentA.post(`${RECURRING}/${scheduleId}/run`).send({});
    expect(runRes.status).toBe(200);
    expect(runRes.body.generated).toBe(1);

    const listRes = await agentA.get(`${INVOICES}?customerId=${customerId}&limit=100`);
    const invoices = listRes.body.invoices as Array<{ id: string; issueDate: string; totalCents: number; status: string }>;
    const generated = invoices.find((inv) => inv.id !== template.id);
    expect(generated).toBeDefined();
    expect(generated?.issueDate).toBe(today());
    expect(generated?.status).toBe('DRAFT');
    expect(generated?.totalCents).toBe(templateInvoice.totalCents);

    const detailRes = await agentA.get(`${INVOICES}/${generated?.id}`);
    expect(detailRes.body.invoice.lines).toHaveLength((templateInvoice.lines as unknown[]).length);

    const schedule = runRes.body.schedule as { nextOccurrenceIndex: number; nextRunDate: string };
    expect(schedule.nextOccurrenceIndex).toBe(1);
    expect(schedule.nextRunDate).toBe(occurrenceDate(today(), 'MONTHLY', 1, 1));
  });

  it('running twice on the same day generates exactly one document', async () => {
    const template = await createDraftInvoice(agentA, customerId, revenueAccountId);
    const createRes = await agentA.post(RECURRING).send({
      kind: 'INVOICE',
      sourceId: template.id,
      name: 'Monthly invoice',
      frequency: 'MONTHLY',
      startDate: today(),
    });
    const scheduleId = createRes.body.schedule.id as string;

    const before = await agentA.get(`${INVOICES}?customerId=${customerId}&limit=100`);
    expect(before.body.totalCount).toBe(1);

    const firstRun = await agentA.post(`${RECURRING}/${scheduleId}/run`).send({});
    expect(firstRun.body.generated).toBe(1);
    const secondRun = await agentA.post(`${RECURRING}/${scheduleId}/run`).send({});
    expect(secondRun.body.generated).toBe(0);

    const after = await agentA.get(`${INVOICES}?customerId=${customerId}&limit=100`);
    expect(after.body.totalCount).toBe(2);
  });

  it('POST mode issues the invoice and posts its journal entry', async () => {
    const template = await createDraftInvoice(agentA, customerId, revenueAccountId);
    const createRes = await agentA.post(RECURRING).send({
      kind: 'INVOICE',
      sourceId: template.id,
      name: 'Monthly posted invoice',
      frequency: 'MONTHLY',
      startDate: today(),
      mode: 'POST',
    });
    const scheduleId = createRes.body.schedule.id as string;

    await agentA.post(`${RECURRING}/${scheduleId}/run`).send({});
    const schedule = await getSchedule(agentA, scheduleId);
    const runs = schedule.runs as Array<{ invoiceId: string | null }>;
    const invoiceId = runs[0]?.invoiceId;
    expect(invoiceId).toBeTruthy();

    const invoiceRes = await agentA.get(`${INVOICES}/${invoiceId}`);
    expect(invoiceRes.body.invoice.status).toBe('ISSUED');
    expect(invoiceRes.body.invoice.journalEntryId).toBeTruthy();

    const tbRes = await agentA.get('/api/v1/reports/trial-balance');
    expect(tbRes.body.isBalanced).toBe(true);
  });
});

describe('bill schedules', () => {
  it('a POST bill schedule posts a bill with a date-suffixed vendor reference', async () => {
    const template = await createDraftBill(agentA, vendorId, expenseAccountId, { vendorReference: 'INV-500' });
    const createRes = await agentA.post(RECURRING).send({
      kind: 'BILL',
      sourceId: template.id,
      name: 'Monthly posted bill',
      frequency: 'MONTHLY',
      startDate: today(),
      mode: 'POST',
    });
    const scheduleId = createRes.body.schedule.id as string;

    await agentA.post(`${RECURRING}/${scheduleId}/run`).send({});
    const schedule = await getSchedule(agentA, scheduleId);
    const runs = schedule.runs as Array<{ billId: string | null }>;
    const billId = runs[0]?.billId;
    expect(billId).toBeTruthy();

    const billRes = await agentA.get(`${BILLS}/${billId}`);
    expect(billRes.body.bill.status).toBe('POSTED');
    expect(billRes.body.bill.vendorReference).toBe(`INV-500-${today()}`);
  });
});

describe('journal schedules', () => {
  it('a recurring journal posts and auto-reverses on the first of next month', async () => {
    const template = await createManualJournal(agentA, expenseAccountId, creditAccountId, 5000);
    const createRes = await agentA.post(RECURRING).send({
      kind: 'JOURNAL',
      sourceId: template.id,
      name: 'Monthly rent journal',
      frequency: 'MONTHLY',
      startDate: today(),
      mode: 'POST',
      autoReverse: true,
    });
    expect(createRes.status).toBe(201);
    const scheduleId = createRes.body.schedule.id as string;

    await agentA.post(`${RECURRING}/${scheduleId}/run`).send({});
    const schedule = await getSchedule(agentA, scheduleId);
    const runs = schedule.runs as Array<{ journalEntryId: string | null; reversalEntryId: string | null }>;
    const run = runs[0];
    expect(run?.journalEntryId).toBeTruthy();
    expect(run?.reversalEntryId).toBeTruthy();

    const reversalRes = await agentA.get(`${JOURNALS}/${run?.reversalEntryId}`);
    expect(reversalRes.body.entry.entryDate).toBe(firstDayOfNextMonth(today()));

    for (const acc of [expenseAccountId, creditAccountId]) {
      const { rows } = await pool.query<{ balance: string }>(
        `SELECT COALESCE(SUM(base_debit_cents - base_credit_cents), 0)::text AS balance
           FROM ledger_lines l
          WHERE l.account_id = $1 AND l.journal_entry_id IN ($2, $3)`,
        [acc, run?.journalEntryId, run?.reversalEntryId],
      );
      expect(rows[0]?.balance).toBe('0');
    }
  });

  it('a journal template touching a control account is refused', async () => {
    const rawEntryId = await insertRawJournalEntry(orgA, userA.id, today(), [
      { accountId: arAccountId, debitCents: 1000, creditCents: 0 },
      { accountId: expenseAccountId, debitCents: 0, creditCents: 1000 },
    ]);

    const res = await agentA.post(RECURRING).send({
      kind: 'JOURNAL',
      sourceId: rawEntryId,
      name: 'Bad journal schedule',
      frequency: 'MONTHLY',
      startDate: today(),
      mode: 'POST',
    });
    expect(res.status).toBe(422);
  });

  it('a DRAFT journal schedule is refused', async () => {
    const template = await createManualJournal(agentA, expenseAccountId, creditAccountId, 5000);
    const res = await agentA.post(RECURRING).send({
      kind: 'JOURNAL',
      sourceId: template.id,
      name: 'Bad mode schedule',
      frequency: 'MONTHLY',
      startDate: today(),
      mode: 'DRAFT',
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('A recurring journal always posts');
  });
});

describe('lifecycle', () => {
  it('end date stops the schedule', async () => {
    const template = await createDraftInvoice(agentA, customerId, revenueAccountId);
    const createRes = await agentA.post(RECURRING).send({
      kind: 'INVOICE',
      sourceId: template.id,
      name: 'One-shot invoice',
      frequency: 'MONTHLY',
      startDate: today(),
      endDate: today(),
    });
    const scheduleId = createRes.body.schedule.id as string;

    const runRes = await agentA.post(`${RECURRING}/${scheduleId}/run`).send({});
    expect(runRes.body.schedule.status).toBe('ENDED');
    expect(runRes.body.schedule.nextRunDate).toBeNull();
  });

  it('pause then resume skips missed occurrences', async () => {
    const template = await createDraftInvoice(agentA, customerId, revenueAccountId);
    const startDate = addDays(today(), -21);
    const createRes = await agentA.post(RECURRING).send({
      kind: 'INVOICE',
      sourceId: template.id,
      name: 'Weekly invoice',
      frequency: 'WEEKLY',
      startDate,
    });
    const scheduleId = createRes.body.schedule.id as string;

    const pauseRes = await agentA.post(`${RECURRING}/${scheduleId}/pause`).send({});
    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body.schedule.status).toBe('PAUSED');

    const resumeRes = await agentA.post(`${RECURRING}/${scheduleId}/resume`).send({});
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.schedule.status).toBe('ACTIVE');
    expect((resumeRes.body.schedule.nextRunDate as string) >= today()).toBe(true);

    const invoicesRes = await agentA.get(`${INVOICES}?customerId=${customerId}&limit=100`);
    expect(invoicesRes.body.totalCount).toBe(1); // only the template
  });

  it('ENDED cannot resume', async () => {
    const template = await createDraftInvoice(agentA, customerId, revenueAccountId);
    const createRes = await agentA.post(RECURRING).send({
      kind: 'INVOICE',
      sourceId: template.id,
      name: 'To be ended',
      frequency: 'MONTHLY',
      startDate: today(),
    });
    const scheduleId = createRes.body.schedule.id as string;

    const endRes = await agentA.post(`${RECURRING}/${scheduleId}/end`).send({});
    expect(endRes.status).toBe(200);
    expect(endRes.body.schedule.status).toBe('ENDED');

    const resumeRes = await agentA.post(`${RECURRING}/${scheduleId}/resume`).send({});
    expect(resumeRes.status).toBe(409);
    expect(resumeRes.body.error).toBe('This schedule cannot move from ENDED to ACTIVE');
  });
});

describe('closed period', () => {
  async function setupClosedPeriodSchedule(): Promise<string> {
    const template = await createManualJournal(agentA, expenseAccountId, creditAccountId, 4200);
    const createRes = await agentA.post(RECURRING).send({
      kind: 'JOURNAL',
      sourceId: template.id,
      name: 'Blocked by closed period',
      frequency: 'MONTHLY',
      startDate: today(),
      mode: 'POST',
    });
    const scheduleId = createRes.body.schedule.id as string;
    await closeTodayPeriod(agentA);
    return scheduleId;
  }

  it('a closed period records lastError and generates nothing', async () => {
    const scheduleId = await setupClosedPeriodSchedule();

    const runRes = await agentA.post(`${RECURRING}/${scheduleId}/run`).send({});
    expect(runRes.status).toBe(200);
    expect(runRes.body.generated).toBe(0);
    expect((runRes.body.lastError as string).toLowerCase()).toContain('fiscal period');

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM recurring_runs WHERE schedule_id = $1',
      [scheduleId],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('rollback: a failing occurrence leaves no document and no run row', async () => {
    const scheduleId = await setupClosedPeriodSchedule();
    const before = await agentA.get(`${INVOICES}?limit=100`);

    await agentA.post(`${RECURRING}/${scheduleId}/run`).send({});

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM journal_entries WHERE org_id = $1 AND source_type = 'recurring' AND source_id = $2`,
      [orgA, scheduleId],
    );
    expect(rows[0]?.count).toBe('0');

    const { rows: runRows } = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM recurring_runs WHERE schedule_id = $1',
      [scheduleId],
    );
    expect(runRows[0]?.count).toBe('0');

    const after = await agentA.get(`${INVOICES}?limit=100`);
    expect(after.body.totalCount).toBe(before.body.totalCount);
  });
});

describe('the sweep', () => {
  it('listDueSchedules returns only ACTIVE schedules due today or earlier', async () => {
    const dueTemplateA = await createDraftInvoice(agentA, customerId, revenueAccountId);
    const dueCreateA = await agentA.post(RECURRING).send({
      kind: 'INVOICE',
      sourceId: dueTemplateA.id,
      name: 'Due today A',
      frequency: 'MONTHLY',
      startDate: today(),
    });
    const dueScheduleIdA = dueCreateA.body.schedule.id as string;

    const pausedTemplateA = await createDraftInvoice(agentA, customerId, revenueAccountId);
    const pausedCreateA = await agentA.post(RECURRING).send({
      kind: 'INVOICE',
      sourceId: pausedTemplateA.id,
      name: 'Paused A',
      frequency: 'MONTHLY',
      startDate: today(),
    });
    const pausedScheduleIdA = pausedCreateA.body.schedule.id as string;
    await agentA.post(`${RECURRING}/${pausedScheduleIdA}/pause`).send({});

    const futureTemplateA = await createDraftInvoice(agentA, customerId, revenueAccountId);
    await agentA.post(RECURRING).send({
      kind: 'INVOICE',
      sourceId: futureTemplateA.id,
      name: 'Future A',
      frequency: 'MONTHLY',
      startDate: addDays(today(), 10),
    });

    const customerBRes = await agentB.post(CUSTOMERS).send({ name: 'Org B Customer' });
    const customerBId = customerBRes.body.customer.id as string;
    const revenueAccountIdB = await accountId(orgB, '4100');
    const dueTemplateB = await createDraftInvoice(agentB, customerBId, revenueAccountIdB);
    const dueCreateB = await agentB.post(RECURRING).send({
      kind: 'INVOICE',
      sourceId: dueTemplateB.id,
      name: 'Due today B',
      frequency: 'MONTHLY',
      startDate: today(),
    });
    const dueScheduleIdB = dueCreateB.body.schedule.id as string;

    const due = await recurringService.listDueSchedules();
    const dueIds = due.map((d) => d.scheduleId);

    expect(dueIds).toContain(dueScheduleIdA);
    expect(dueIds).toContain(dueScheduleIdB);
    expect(dueIds).not.toContain(pausedScheduleIdA);

    const entryA = due.find((d) => d.scheduleId === dueScheduleIdA);
    const entryB = due.find((d) => d.scheduleId === dueScheduleIdB);
    expect(entryA?.orgId).toBe(orgA);
    expect(entryB?.orgId).toBe(orgB);
  });
});

describe('cross-tenant isolation', () => {
  it('org B cannot read, run or pause org A schedules', async () => {
    const template = await createDraftInvoice(agentA, customerId, revenueAccountId);
    const createRes = await agentA.post(RECURRING).send({
      kind: 'INVOICE',
      sourceId: template.id,
      name: 'Org A only',
      frequency: 'MONTHLY',
      startDate: today(),
    });
    const scheduleId = createRes.body.schedule.id as string;

    const getRes = await agentB.get(`${RECURRING}/${scheduleId}`);
    expect(getRes.status).toBe(404);
    const runRes = await agentB.post(`${RECURRING}/${scheduleId}/run`).send({});
    expect(runRes.status).toBe(404);
    const pauseRes = await agentB.post(`${RECURRING}/${scheduleId}/pause`).send({});
    expect(pauseRes.status).toBe(404);

    const stillA = await getSchedule(agentA, scheduleId);
    expect(stillA.status).toBe('ACTIVE');
    expect(stillA.nextOccurrenceIndex).toBe(0);
  });

  it('a schedule cannot use another org template', async () => {
    const template = await createDraftInvoice(agentA, customerId, revenueAccountId);

    const res = await agentB.post(RECURRING).send({
      kind: 'INVOICE',
      sourceId: template.id,
      name: 'Stolen template',
      frequency: 'MONTHLY',
      startDate: today(),
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Source invoice not found');
  });

  it('runDueOccurrences with a mismatched orgId does nothing', async () => {
    const template = await createDraftInvoice(agentA, customerId, revenueAccountId);
    const createRes = await agentA.post(RECURRING).send({
      kind: 'INVOICE',
      sourceId: template.id,
      name: 'Org A schedule',
      frequency: 'MONTHLY',
      startDate: today(),
    });
    const scheduleId = createRes.body.schedule.id as string;

    const result = await recurringService.runDueOccurrences(orgB, scheduleId);
    expect(result.generated).toBe(0);

    const invoicesRes = await agentA.get(`${INVOICES}?customerId=${customerId}&limit=100`);
    expect(invoicesRes.body.totalCount).toBe(1); // only the template
  });
});

describe('roles', () => {
  it('a VIEWER cannot create a schedule', async () => {
    const template = await createDraftInvoice(agentA, customerId, revenueAccountId);

    const viewer = await createUserWithOrg({ label: 'recurring-viewer', orgName: 'unused' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const viewerAgent = await loginAgent(app, viewer);
    await viewerAgent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const res = await viewerAgent.post(RECURRING).send({
      kind: 'INVOICE',
      sourceId: template.id,
      name: 'Viewer attempt',
      frequency: 'MONTHLY',
      startDate: today(),
    });
    expect(res.status).toBe(403);
  });
});

describe('query validation', () => {
  it('an invalid kind filter is a 400', async () => {
    const res = await agentA.get(`${RECURRING}?kind=NOPE`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
