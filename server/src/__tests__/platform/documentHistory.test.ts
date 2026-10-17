import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import {
  accountId,
  createCustomer,
  issueCreditNote,
  issueInvoice,
  postBill,
  receivePayment,
  type Agent,
} from '../helpers/accountingFixtures.js';
import { latestEmailToken } from '../helpers/email.js';
import * as recurringService from '../../services/accounting/recurringService.js';

/**
 * Phase 46c — History & notes. Integration tier, real PostgreSQL. The
 * timeline is written by each document's own service on its own transaction
 * client: these tests prove the actions and their order, that a note is
 * validated and permission-gated, that another tenant's id is a 404 that
 * writes nothing, that the table is append-only, that a rolled-back
 * transaction leaves no event, and that system actions carry no actor.
 */

const app = createApp();
const INVOICES = '/api/v1/invoices';
const QUOTES = '/api/v1/quotes';
const PUBLIC_QUOTES = '/api/v1/public/quotes';
const RECURRING = '/api/v1/recurring-schedules';

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let agentA: Agent;
let agentB: Agent;
let customerId: string;

interface HistoryRow {
  action: string;
  kind: string;
  summary: string;
  actorUserId: string | null;
  actorName: string | null;
}

async function history(agent: Agent, prefix: string, id: string): Promise<HistoryRow[]> {
  const res = await agent.get(`/api/v1/${prefix}/${id}/history`);
  if (res.status !== 200) throw new Error(`fixture: history ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.history as HistoryRow[];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function invoiceBody(orgId: string, unitPriceCents: number): Promise<Record<string, unknown>> {
  return {
    customerId,
    issueDate: today(),
    dueDate: today(),
    notes: null,
    paymentTerms: null,
    lines: [
      {
        description: 'Consulting',
        quantityMilli: 1000,
        unitPriceCents,
        revenueAccountId: await accountId(orgId, '4100'),
        taxRateBp: 0,
      },
    ],
  };
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'History Org A' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'History Org B' });
  orgA = userA.orgId;
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  customerId = await createCustomer(agentA, 'Acme Fitouts', 'buyer@acme.test');
});

afterAll(closePool);

describe('document timelines', () => {
  it('invoice timeline: created, edited, issued, paid, payment voided (newest first)', async () => {
    const created = await agentA.post(INVOICES).send(await invoiceBody(orgA, 10000));
    expect(created.status).toBe(201);
    const id = created.body.invoice.id as string;

    const edited = await agentA.patch(`${INVOICES}/${id}`).send(await invoiceBody(orgA, 12000));
    expect(edited.status).toBe(200);
    expect((await agentA.post(`${INVOICES}/${id}/issue`).send({})).status).toBe(200);

    const paymentId = await receivePayment(agentA, orgA, customerId, today(), [{ invoiceId: id, amountCents: 12000 }]);
    const voided = await agentA.post(`/api/v1/payments/${paymentId}/void`).send({});
    expect(voided.status).toBe(200);

    const res = await agentA.get(`${INVOICES}/${id}/history`);
    expect(res.status).toBe(200);
    const rows = res.body.history as HistoryRow[];
    expect(res.body.count).toBe(5);
    expect(rows.map((r) => r.action)).toEqual(['PAYMENT_VOIDED', 'PAYMENT_RECEIVED', 'ISSUED', 'UPDATED', 'CREATED']);
    for (const row of rows) expect(row.actorName).toBe('alice');
    expect(rows[2]?.summary).toMatch(/^Issued as .+ for USD 120\.00$/);

    // The payment's own timeline is created then voided.
    const payment = await history(agentA, 'payments', paymentId);
    expect(payment.map((r) => r.action)).toEqual(['VOIDED', 'CREATED']);
  });

  it('credit note application appears on both timelines', async () => {
    const invoice = await issueInvoice(agentA, orgA, customerId, 20000, today(), today());
    const noteId = await issueCreditNote(agentA, orgA, invoice.id, 5000, today());

    const invoiceHistory = await history(agentA, 'invoices', invoice.id);
    const noteHistory = await history(agentA, 'credit-notes', noteId);
    expect(invoiceHistory.map((r) => r.action)).toContain('CREDIT_APPLIED');
    expect(noteHistory.map((r) => r.action)).toContain('CREDIT_APPLIED');
    expect(noteHistory.map((r) => r.action)).toEqual(['CREDIT_APPLIED', 'ISSUED', 'CREATED']);
    expect(noteHistory[0]?.summary).toBe(`Applied USD 50.00 to invoice ${invoice.number}`);
  });

  it('bill approval records APPROVED with the money in its currency', async () => {
    const vendor = await agentA.post('/api/v1/vendors').send({ name: 'Paper Co' });
    expect(vendor.status).toBe(201);
    const bill = await postBill(agentA, orgA, vendor.body.vendor.id as string, {
      billDate: today(),
      unitPriceCents: 10000,
    });
    const rows = await history(agentA, 'bills', bill.id);
    expect(rows.map((r) => r.action)).toEqual(['APPROVED', 'SUBMITTED', 'CREATED']);
    expect(rows[0]?.summary).toBe('Approved for USD 100.00');
  });
});

describe('notes', () => {
  it('adds a note, rejects blank and over-long text, and gates on the edit permission', async () => {
    const invoice = await issueInvoice(agentA, orgA, customerId, 10000, today(), today());

    const ok = await agentA.post(`${INVOICES}/${invoice.id}/notes`).send({ text: 'Called the customer' });
    expect(ok.status).toBe(201);
    expect(ok.body.entry).toMatchObject({ kind: 'NOTE', action: 'NOTE', summary: 'Called the customer', actorName: 'alice' });
    expect((await history(agentA, 'invoices', invoice.id))[0]?.kind).toBe('NOTE');

    const blank = await agentA.post(`${INVOICES}/${invoice.id}/notes`).send({ text: '   ' });
    expect(blank.status).toBe(400);
    const long = await agentA.post(`${INVOICES}/${invoice.id}/notes`).send({ text: 'x'.repeat(1001) });
    expect(long.status).toBe(400);

    const viewer = await createUserWithOrg({ label: 'viewer', orgName: 'unused' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const viewerAgent = await loginAgent(app, viewer);
    await viewerAgent.post('/api/v1/auth/switch-org').send({ orgId: orgA });
    const denied = await viewerAgent.post(`${INVOICES}/${invoice.id}/notes`).send({ text: 'sneaky' });
    expect(denied.status).toBe(403);
    // A viewer may read the timeline.
    expect((await viewerAgent.get(`${INVOICES}/${invoice.id}/history`)).status).toBe(200);
  });
});

describe('cross-tenant isolation', () => {
  it('another tenant cannot read or annotate a timeline, and nothing is written', async () => {
    const invoice = await issueInvoice(agentA, orgA, customerId, 10000, today(), today());
    const count = async (): Promise<number> => {
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM document_history WHERE entity_type = 'INVOICE' AND entity_id = $1`,
        [invoice.id],
      );
      return Number(rows[0]?.n);
    };
    const before = await count();

    const read = await agentB.get(`${INVOICES}/${invoice.id}/history`);
    expect(read.status).toBe(404);
    expect(read.body.error).toBe('Invoice not found');
    const write = await agentB.post(`${INVOICES}/${invoice.id}/notes`).send({ text: 'not yours' });
    expect(write.status).toBe(404);

    expect(await count()).toBe(before);
  });
});

describe('append-only', () => {
  it('UPDATE and DELETE are rejected by the trigger', async () => {
    const invoice = await issueInvoice(agentA, orgA, customerId, 10000, today(), today());
    await expect(pool.query(`UPDATE document_history SET summary = 'x' WHERE entity_id = $1`, [invoice.id])).rejects.toMatchObject({
      code: '0A000',
    });
    await expect(pool.query('DELETE FROM document_history WHERE entity_id = $1', [invoice.id])).rejects.toMatchObject({
      code: '0A000',
    });
  });
});

describe('rollback', () => {
  it('a failed issue leaves no ISSUED event behind', async () => {
    const created = await agentA.post(INVOICES).send(await invoiceBody(orgA, 10000));
    const id = created.body.invoice.id as string;
    // Turn the revenue account into a header after the draft exists, so the issue itself fails.
    await pool.query(`UPDATE accounts SET is_postable = false WHERE org_id = $1 AND code = '4100'`, [orgA]);

    const issue = await agentA.post(`${INVOICES}/${id}/issue`).send({});
    expect(issue.status).toBe(422);

    const rows = await history(agentA, 'invoices', id);
    expect(rows.map((r) => r.action)).toEqual(['CREATED']);
    const { rows: leaked } = await pool.query(
      `SELECT 1 FROM document_history WHERE entity_id = $1 AND action = 'ISSUED'`,
      [id],
    );
    expect(leaked).toHaveLength(0);
  });
});

describe('system actions carry no actor', () => {
  it('a public quote acceptance is recorded with a null actor', async () => {
    const created = await agentA.post(QUOTES).send({
      partyId: customerId,
      quoteDate: today(),
      validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
      title: 'Fit-out',
      terms: 'Payment 50% on acceptance.',
      lines: [
        {
          description: 'Installation',
          quantityMilli: 1000,
          unitPriceCents: 50000,
          accountId: await accountId(orgA, '4100'),
          taxRateBp: 0,
        },
      ],
    });
    expect(created.status).toBe(201);
    const id = created.body.quote.id as string;
    expect((await agentA.post(`${QUOTES}/${id}/send`).send({ delivery: 'EMAIL', toEmail: 'buyer@acme.test' })).status).toBe(200);
    const token = await latestEmailToken('buyer@acme.test', 'quote_sent');
    const view = await request(app).get(`${PUBLIC_QUOTES}/${token}`);
    const accept = await request(app)
      .post(`${PUBLIC_QUOTES}/${token}/accept`)
      .send({ signerName: 'Jane Doe', acceptTerms: true, contentSha256: view.body.quote.contentSha256 });
    expect(accept.status).toBe(200);

    const rows = await history(agentA, 'quotes', id);
    expect(rows.map((r) => r.action)).toEqual(['ACCEPTED', 'SENT', 'CREATED']);
    expect(rows[0]?.actorUserId).toBeNull();
    expect(rows[0]?.actorName).toBeNull();
    expect(rows[1]?.actorUserId).toBe(userA.id);
  });

  it('a recurring run creates its invoice with a null actor', async () => {
    const template = await agentA.post(INVOICES).send(await invoiceBody(orgA, 10000));
    expect(template.status).toBe(201);
    const schedule = await agentA.post(RECURRING).send({
      kind: 'INVOICE',
      sourceId: template.body.invoice.id,
      name: 'Monthly retainer',
      frequency: 'MONTHLY',
      startDate: today(),
    });
    expect(schedule.status).toBe(201);
    const result = await recurringService.runDueOccurrences(orgA, schedule.body.schedule.id as string);
    expect(result.generated).toBe(1);

    const { rows } = await pool.query<{ invoice_id: string }>(
      'SELECT invoice_id FROM recurring_runs WHERE org_id = $1 AND schedule_id = $2',
      [orgA, schedule.body.schedule.id],
    );
    const generatedId = rows[0]?.invoice_id;
    if (generatedId === undefined) throw new Error('fixture: recurring run produced no invoice');
    const generated = await history(agentA, 'invoices', generatedId);
    expect(generated.map((r) => r.action)).toContain('CREATED');
    expect(generated.find((r) => r.action === 'CREATED')?.actorUserId).toBeNull();
  });
});
