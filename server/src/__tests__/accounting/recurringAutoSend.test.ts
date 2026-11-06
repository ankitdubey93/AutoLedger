import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId, createCustomer, type Agent } from '../helpers/accountingFixtures.js';
import { addDays } from '../../utils/recurrence.js';

/**
 * Phase 48 — recurring auto-send. Integration tier, real PostgreSQL. A
 * schedule created with `autoSend` emails each invoice it issues, on the
 * worker's own transaction, so a rolled-back occurrence sends nothing.
 */

const app = createApp();
const RECURRING = '/api/v1/recurring-schedules';
const INVOICES = '/api/v1/invoices';
const PERIODS = '/api/v1/fiscal-periods';
const ONBOARDING = '/api/v1/settings/onboarding';
const CUSTOMER_EMAIL = 'ap@northwind.test';

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let agentA: Agent;
let agentB: Agent;
let customerId: string;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function createTemplate(forCustomerId: string): Promise<string> {
  const res = await agentA.post(INVOICES).send({
    customerId: forCustomerId,
    issueDate: today(),
    dueDate: addDays(today(), 30),
    lines: [
      {
        description: 'Retainer',
        quantityMilli: 1000,
        unitPriceCents: 10000,
        revenueAccountId: await accountId(orgA, '4100'),
        taxRateBp: 0,
      },
    ],
  });
  if (res.status !== 201) throw new Error(`fixture: template failed ${res.status}`);
  return res.body.invoice.id as string;
}

function scheduleBody(sourceId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'INVOICE',
    sourceId,
    name: 'Monthly retainer',
    frequency: 'MONTHLY',
    startDate: today(),
    mode: 'POST',
    autoSend: true,
    ...overrides,
  };
}

async function createSchedule(body: Record<string, unknown>): Promise<string> {
  const res = await agentA.post(RECURRING).send(body);
  if (res.status !== 201) throw new Error(`fixture: schedule failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.schedule.id as string;
}

async function counts(): Promise<{ sends: number; outbox: number }> {
  const s = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM invoice_sends WHERE org_id = $1', [orgA]);
  const o = await pool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM email_outbox WHERE org_id = $1 AND template = 'invoice_sent'",
    [orgA],
  );
  return { sends: Number(s.rows[0]?.n), outbox: Number(o.rows[0]?.n) };
}

async function generatedInvoiceIds(templateId: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM invoices WHERE org_id = $1 AND id <> $2', [
    orgA,
    templateId,
  ]);
  return rows.map((r) => r.id);
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'autosend-a', orgName: 'Harbor Point' });
  userB = await createUserWithOrg({ label: 'autosend-b', orgName: 'Other Org' });
  orgA = userA.orgId;
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  customerId = await createCustomer(agentA, 'Northwind Traders', CUSTOMER_EMAIL);
});

afterAll(closePool);

describe('recurring invoice auto-send', () => {
  it('emails the issued invoice: one invoice_sent row, a RECURRING send by the schedule creator', async () => {
    const templateId = await createTemplate(customerId);
    const scheduleId = await createSchedule(scheduleBody(templateId));
    const run = await agentA.post(`${RECURRING}/${scheduleId}/run`).send({});
    expect(run.status).toBe(200);
    expect(run.body.generated).toBe(1);

    const [invoiceId] = await generatedInvoiceIds(templateId);
    const issued = await pool.query<{ status: string }>('SELECT status FROM invoices WHERE id = $1 AND org_id = $2', [
      invoiceId,
      orgA,
    ]);
    expect(issued.rows[0]?.status).toBe('ISSUED');

    expect(await counts()).toEqual({ sends: 1, outbox: 1 });
    const send = await pool.query<{ send_kind: string; sent_by: string; invoice_id: string }>(
      'SELECT send_kind, sent_by, invoice_id FROM invoice_sends WHERE org_id = $1',
      [orgA],
    );
    expect(send.rows[0]).toEqual({ send_kind: 'RECURRING', sent_by: userA.id, invoice_id: invoiceId });
  });

  it('autoSend false sends nothing', async () => {
    const templateId = await createTemplate(customerId);
    const scheduleId = await createSchedule(scheduleBody(templateId, { autoSend: false }));
    expect((await agentA.post(`${RECURRING}/${scheduleId}/run`).send({})).body.generated).toBe(1);
    expect(await counts()).toEqual({ sends: 0, outbox: 0 });
  });

  it('a second run for the same date still leaves one email', async () => {
    const templateId = await createTemplate(customerId);
    const scheduleId = await createSchedule(scheduleBody(templateId));
    await agentA.post(`${RECURRING}/${scheduleId}/run`).send({});
    const again = await agentA.post(`${RECURRING}/${scheduleId}/run`).send({});
    expect(again.body.generated).toBe(0);
    expect(await counts()).toEqual({ sends: 1, outbox: 1 });
  });

  it('a customer with no email still gets the invoice issued, no send, and a SEND_SKIPPED event', async () => {
    const noEmail = await createCustomer(agentA, 'No Email Ltd');
    const templateId = await createTemplate(noEmail);
    const scheduleId = await createSchedule(scheduleBody(templateId));
    const run = await agentA.post(`${RECURRING}/${scheduleId}/run`).send({});
    expect(run.status).toBe(200);
    expect(run.body.generated).toBe(1);

    const [invoiceId] = await generatedInvoiceIds(templateId);
    const issued = await pool.query<{ status: string }>('SELECT status FROM invoices WHERE id = $1 AND org_id = $2', [
      invoiceId,
      orgA,
    ]);
    expect(issued.rows[0]?.status).toBe('ISSUED');
    expect(await counts()).toEqual({ sends: 0, outbox: 0 });

    const history = await pool.query(
      "SELECT 1 FROM document_history WHERE org_id = $1 AND entity_id = $2 AND action = 'SEND_SKIPPED'",
      [orgA, invoiceId],
    );
    expect(history.rowCount).toBe(1);
  });

  it('refuses autoSend on a DRAFT-mode invoice schedule and on a bill schedule (422)', async () => {
    const templateId = await createTemplate(customerId);
    const draft = await agentA.post(RECURRING).send(scheduleBody(templateId, { mode: 'DRAFT' }));
    expect(draft.status).toBe(422);
    expect(draft.body.error).toBe('Only an invoice that is issued automatically can be emailed automatically');

    const vendor = await agentA.post('/api/v1/vendors').send({ name: 'Acme Supplies' });
    const bill = await agentA.post('/api/v1/bills').send({
      vendorId: vendor.body.vendor.id,
      vendorReference: 'INV-100',
      billDate: today(),
      dueDate: addDays(today(), 30),
      lines: [
        { description: 'Supplies', quantityMilli: 1000, unitPriceCents: 20000, expenseAccountId: await accountId(orgA, '6120') },
      ],
    });
    expect(bill.status).toBe(201);
    const refused = await agentA
      .post(RECURRING)
      .send(scheduleBody(bill.body.bill.id as string, { kind: 'BILL', mode: 'POST' }));
    expect(refused.status).toBe(422);
  });

  it('ck_recurring_auto_send rejects a raw auto_send schedule in DRAFT mode (23514)', async () => {
    const templateId = await createTemplate(customerId);
    await expect(
      pool.query(
        `INSERT INTO recurring_schedules
           (org_id, kind, name, source_invoice_id, frequency, start_date, next_run_date, mode, auto_send, created_by)
         VALUES ($1, 'INVOICE', 'Raw', $2, 'MONTHLY', $3, $3, 'DRAFT', true, $4)`,
        [orgA, templateId, today(), userA.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('a failure while issuing leaves no outbox row and no send', async () => {
    const templateId = await createTemplate(customerId);
    const scheduleId = await createSchedule(scheduleBody(templateId));

    const onboard = await agentA.post(ONBOARDING).send({
      organizationName: 'Harbor Point',
      baseCurrency: 'USD',
      fiscalYearStartMonth: 1,
      booksStartDate: `${today().slice(0, 4)}-01-01`,
    });
    expect(onboard.status).toBe(200);
    const generated = await agentA.post(`${PERIODS}/generate`).send({ containingDate: today() });
    const period = (generated.body.periods as { id: string; startsOn: string }[]).find((p) =>
      p.startsOn.startsWith(today().slice(0, 7)),
    );
    expect(period).toBeDefined();
    expect((await agentA.post(`${PERIODS}/${period?.id}/close`).send({})).status).toBe(200);

    await agentA.post(`${RECURRING}/${scheduleId}/run`).send({});
    expect(await generatedInvoiceIds(templateId)).toEqual([]);
    expect(await counts()).toEqual({ sends: 0, outbox: 0 });
  });

  it("org B cannot read org A's schedule (404)", async () => {
    const templateId = await createTemplate(customerId);
    const scheduleId = await createSchedule(scheduleBody(templateId));
    expect((await agentB.get(`${RECURRING}/${scheduleId}`)).status).toBe(404);
    expect((await agentA.get(`${RECURRING}/${scheduleId}`)).body.schedule.autoSend).toBe(true);
  });
});
