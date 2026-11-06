import { createHmac } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import * as onlinePaymentService from '../../services/accounting/onlinePaymentService.js';
import * as stripeClient from '../../services/payments/stripeClient.js';
import type { StripeDeps } from '../../services/payments/stripeClient.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { latestEmailLink } from '../helpers/email.js';
import { accountId, createCustomer, issueInvoice, receivePayment, type Agent } from '../helpers/accountingFixtures.js';

/**
 * Phase 48 — the public invoice link and paying through it. Integration tier,
 * real PostgreSQL, Stripe replaced by an in-memory fake injected through `deps`
 * (the pattern onlinePayments.test.ts uses).
 *
 * The claims: the token picks the tenant and nothing else can; the server, not
 * the browser, prices the payment; a succeeded intent becomes exactly one
 * receipt under any ordering of webhook and browser.
 */

const app = createApp();
const PUBLIC = '/api/v1/public/invoices';
const WEBHOOK_SECRET = 'whsec_test_secret';

let userA: SeededUser;
let orgA: string;
let agentA: Agent;
let customerId: string;
let invoice: { id: string; number: string };
let token: string;

interface FakeIntent {
  id: string;
  status: string;
  amount: number;
  currency: string;
  client_secret: string;
  metadata: Record<string, string>;
  last_payment_error: { message: string } | null;
}

function fakeStripe() {
  const intents = new Map<string, FakeIntent>();
  const requests: { method: string; url: string; body: URLSearchParams | null }[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? new URLSearchParams(init.body) : null;
    requests.push({ method, url, body });
    if (method === 'POST' && url.endsWith('/v1/payment_intents') && body !== null) {
      const id = `pi_fake${String(intents.size + 1)}`;
      const metadata: Record<string, string> = {};
      for (const [k, v] of body.entries()) {
        const m = /^metadata\[(.+)\]$/.exec(k);
        if (m?.[1] !== undefined) metadata[m[1]] = v;
      }
      const intent: FakeIntent = {
        id,
        status: 'requires_payment_method',
        amount: Number(body.get('amount')),
        currency: body.get('currency') ?? '',
        client_secret: `${id}_secret_abc`,
        metadata,
        last_payment_error: null,
      };
      intents.set(id, intent);
      return Promise.resolve(new Response(JSON.stringify(intent), { status: 200 }));
    }
    const match = /\/v1\/payment_intents\/(pi_[A-Za-z0-9]+)$/.exec(url);
    const found = match?.[1] === undefined ? undefined : intents.get(match[1]);
    if (method === 'GET' && found !== undefined) {
      return Promise.resolve(new Response(JSON.stringify(found), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ error: { message: 'No such payment_intent' } }), { status: 404 }));
  }) as typeof fetch;
  const deps: StripeDeps = {
    config: { secretKey: 'sk_test_fake', publishableKey: 'pk_test_fake', webhookSecret: WEBHOOK_SECRET },
    fetchImpl,
  };
  return { deps, intents, requests };
}

function sign(body: string, secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac('sha256', secret).update(`${String(timestamp)}.${body}`).digest('hex');
  return `t=${String(timestamp)},v1=${sig}`;
}

function event(type: string, intentId: string): string {
  return JSON.stringify({ id: `evt_${intentId}`, type, data: { object: { id: intentId } } });
}

async function enableOnlinePayments(agent: Agent, orgId: string, enabled = true): Promise<void> {
  const res = await agent
    .patch('/api/v1/settings/online-payments')
    .send({ enabled, depositAccountId: await accountId(orgId, '1110') });
  if (res.status !== 200) throw new Error(`fixture: enable failed ${res.status} ${JSON.stringify(res.body)}`);
}

async function sendInvoiceLink(agent: Agent, invoiceId: string, email: string): Promise<string> {
  const res = await agent.post(`/api/v1/invoices/${invoiceId}/send`).send({});
  if (res.status !== 201) throw new Error(`fixture: send failed ${res.status} ${JSON.stringify(res.body)}`);
  const url = await latestEmailLink(email, 'invoice_sent');
  return url.pathname.split('/').pop() ?? '';
}

async function cardPayments(orgId: string): Promise<{ id: string; amount_cents: string; created_by: string }[]> {
  const { rows } = await pool.query<{ id: string; amount_cents: string; created_by: string }>(
    `SELECT id, amount_cents::text AS amount_cents, created_by FROM payments
      WHERE org_id = $1 AND method = 'CARD' AND status = 'POSTED'`,
    [orgId],
  );
  return rows;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetTables();
  userA = await createUserWithOrg({ label: 'pubinv-a', orgName: 'Harbor Point' });
  orgA = userA.orgId;
  agentA = await loginAgent(app, userA);
  customerId = await createCustomer(agentA, 'Northwind Traders', 'ap@northwind.test');
  invoice = await issueInvoice(agentA, orgA, customerId, 11000, '2026-06-01', '2026-06-30');
  await receivePayment(agentA, orgA, customerId, '2026-06-10', [{ invoiceId: invoice.id, amountCents: 1000 }]);
  await enableOnlinePayments(agentA, orgA);
  token = await sendInvoiceLink(agentA, invoice.id, 'ap@northwind.test');
});

afterAll(closePool);

describe('GET /public/invoices/:token', () => {
  it('shows the invoice with no-store, records the view, and leaks no internal ids', async () => {
    expect((await agentA.get(`/api/v1/invoices/${invoice.id}`)).body.invoice.lastViewedAt).toBeNull();
    const res = await request(app).get(`${PUBLIC}/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.invoice).toMatchObject({ number: invoice.number, totalCents: 11000, paidCents: 1000, amountDueCents: 10000 });
    const text = JSON.stringify(res.body);
    for (const forbidden of ['journalEntryId', 'revenueAccountId', 'createdBy']) {
      expect(text).not.toContain(forbidden);
    }
    expect((await agentA.get(`/api/v1/invoices/${invoice.id}`)).body.invoice.lastViewedAt).not.toBeNull();
  });

  it('answers unknown, revoked and expired tokens with the same 404', async () => {
    const unknown = await request(app).get(`${PUBLIC}/${'z'.repeat(43)}`);
    expect(unknown.status).toBe(404);

    const { rows } = await pool.query<{ id: string }>('SELECT id FROM invoice_sends WHERE org_id = $1', [orgA]);
    const sendId = rows[0]?.id ?? '';
    const revoke = await agentA.post(`/api/v1/invoices/${invoice.id}/sends/${sendId}/revoke`).send({});
    expect(revoke.status).toBe(200);
    const revoked = await request(app).get(`${PUBLIC}/${token}`);
    expect(revoked.status).toBe(404);

    await pool.query(
      `UPDATE invoice_sends SET revoked_at = NULL, created_at = now() - interval '2 days',
              expires_at = now() - interval '1 day' WHERE id = $1`,
      [sendId],
    );
    const expired = await request(app).get(`${PUBLIC}/${token}`);
    expect(expired.status).toBe(404);
    expect(revoked.body.error).toBe(unknown.body.error);
    expect(expired.body.error).toBe(unknown.body.error);
  });

  it('serves the PDF through the token, and refuses a non-image document as a logo', async () => {
    const pdf = await request(app).get(`${PUBLIC}/${token}/pdf`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // The vault's mime CHECK admits no SVG; a PDF stands in for "not an image type".
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO documents (org_id, sha256, byte_size, mime_type, original_filename, uploaded_by)
       VALUES ($1, $2, 10, 'application/pdf', 'logo.pdf', $3) RETURNING id`,
      [orgA, 'c'.repeat(64), userA.id],
    );
    await pool.query('UPDATE organization_profiles SET logo_document_id = $2 WHERE org_id = $1', [orgA, rows[0]?.id]);
    expect((await request(app).get(`${PUBLIC}/${token}/logo`)).status).toBe(404);
  });

  it('view reports payment.enabled false when Stripe is unconfigured or the org turned it off', async () => {
    const unconfigured = await request(app).get(`${PUBLIC}/${token}`);
    expect(unconfigured.body.payment.enabled).toBe(false);

    vi.spyOn(stripeClient, 'stripeConfig').mockReturnValue({
      secretKey: 'sk_test_fake',
      publishableKey: 'pk_test_fake',
      webhookSecret: WEBHOOK_SECRET,
    });
    const on = await request(app).get(`${PUBLIC}/${token}`);
    expect(on.body.payment).toEqual({ enabled: true, publishableKey: 'pk_test_fake' });
    await enableOnlinePayments(agentA, orgA, false);
    const off = await request(app).get(`${PUBLIC}/${token}`);
    expect(off.body.payment.enabled).toBe(false);
  });
});

describe('paying through the link', () => {
  it('prices the whole outstanding amount itself and ignores anything the browser sends', async () => {
    const { deps, requests } = fakeStripe();
    const started = await onlinePaymentService.startInvoicePayment(token, deps);
    expect(started).toMatchObject({ amountCents: 10000, currencyCode: 'USD', publishableKey: 'pk_test_fake' });
    expect(requests.find((r) => r.method === 'POST')?.body?.get('amount')).toBe('10000');

    // Over HTTP the route reads no body at all: with Stripe unconfigured it is a 409 either way.
    const other = await issueInvoice(agentA, orgA, customerId, 777, '2026-06-02', '2026-07-02');
    const http = await request(app).post(`${PUBLIC}/${token}/payments`).send({ amountCents: 1, invoiceId: other.id });
    expect(http.status).toBe(409);
    const { rows } = await pool.query<{ invoice_id: string; amount_cents: string }>(
      'SELECT invoice_id, amount_cents::text AS amount_cents FROM online_payment_invoices WHERE org_id = $1',
      [orgA],
    );
    expect(rows).toEqual([{ invoice_id: invoice.id, amount_cents: '10000' }]);
  });

  it('records exactly one receipt for webhook, confirm, webhook — by the sender, balanced', async () => {
    const { deps, intents } = fakeStripe();
    await onlinePaymentService.startInvoicePayment(token, deps);
    const intentId = [...intents.keys()][0] ?? '';
    const intent = intents.get(intentId);
    if (intent !== undefined) intent.status = 'succeeded';

    const body = event('payment_intent.succeeded', intentId);
    await onlinePaymentService.handleWebhook(Buffer.from(body), sign(body), deps);
    const confirmed = await onlinePaymentService.confirmFromInvoiceLink(token, intentId, deps);
    expect(confirmed.status).toBe('RECORDED');
    await onlinePaymentService.handleWebhook(Buffer.from(body), sign(body), deps);

    const payments = await cardPayments(orgA);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ amount_cents: '10000', created_by: userA.id });
    const read = await agentA.get(`/api/v1/invoices/${invoice.id}`);
    expect(read.body.invoice.amountDueCents).toBe(0);

    const { rows: op } = await pool.query<{ status: string }>('SELECT status FROM online_payments WHERE org_id = $1', [orgA]);
    expect(op).toEqual([{ status: 'RECORDED' }]);
    const { rows: sums } = await pool.query<{ debit: string; credit: string }>(
      `SELECT COALESCE(SUM(debit_cents),0)::text AS debit, COALESCE(SUM(credit_cents),0)::text AS credit
         FROM ledger_lines WHERE org_id = $1`,
      [orgA],
    );
    expect(sums[0]?.debit).toBe(sums[0]?.credit);
  });

  it('confirming first, then the webhook, still records one payment', async () => {
    const { deps, intents } = fakeStripe();
    await onlinePaymentService.startInvoicePayment(token, deps);
    const intentId = [...intents.keys()][0] ?? '';
    const intent = intents.get(intentId);
    if (intent !== undefined) intent.status = 'succeeded';

    await onlinePaymentService.confirmFromInvoiceLink(token, intentId, deps);
    const body = event('payment_intent.succeeded', intentId);
    await onlinePaymentService.handleWebhook(Buffer.from(body), sign(body), deps);
    await Promise.all([
      onlinePaymentService.confirmFromInvoiceLink(token, intentId, deps),
      onlinePaymentService.settleIntent(intentId, deps),
    ]);
    expect(await cardPayments(orgA)).toHaveLength(1);
  });

  it('an invoice voided after the intent started goes to NEEDS_REVIEW with no payment', async () => {
    const { deps, intents } = fakeStripe();
    await onlinePaymentService.startInvoicePayment(token, deps);
    const intentId = [...intents.keys()][0] ?? '';
    // A partial receipt blocks a void, so reverse it first.
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM payments WHERE org_id = $1', [orgA]);
    const voidPayment = await agentA.post(`/api/v1/payments/${rows[0]?.id}/void`).send({});
    expect(voidPayment.status).toBe(200);
    expect((await agentA.post(`/api/v1/invoices/${invoice.id}/void`).send({})).status).toBe(200);

    const intent = intents.get(intentId);
    if (intent !== undefined) intent.status = 'succeeded';
    const result = await onlinePaymentService.settleIntent(intentId, deps);
    expect(result).toEqual({ status: 'NEEDS_REVIEW', paymentId: null });
    expect(await cardPayments(orgA)).toHaveLength(0);
  });

  it('is refused (409) when online payments are disabled', async () => {
    const { deps } = fakeStripe();
    await enableOnlinePayments(agentA, orgA, false);
    await expect(onlinePaymentService.startInvoicePayment(token, deps)).rejects.toMatchObject({ status: 409 });
  });

  it('a fully paid invoice shows nothing due and refuses payment (422)', async () => {
    const { deps } = fakeStripe();
    await receivePayment(agentA, orgA, customerId, '2026-06-20', [{ invoiceId: invoice.id, amountCents: 10000 }]);
    const view = await request(app).get(`${PUBLIC}/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.invoice.amountDueCents).toBe(0);
    expect(view.body.payment.enabled).toBe(false);
    await expect(onlinePaymentService.startInvoicePayment(token, deps)).rejects.toMatchObject({ status: 422 });
  });

  it('a void invoice still opens as VOID and refuses payment (422)', async () => {
    const { deps } = fakeStripe();
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM payments WHERE org_id = $1', [orgA]);
    expect((await agentA.post(`/api/v1/payments/${rows[0]?.id}/void`).send({})).status).toBe(200);
    expect((await agentA.post(`/api/v1/invoices/${invoice.id}/void`).send({})).status).toBe(200);
    const view = await request(app).get(`${PUBLIC}/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.invoice).toMatchObject({ status: 'VOID', amountDueCents: 0 });
    await expect(onlinePaymentService.startInvoicePayment(token, deps)).rejects.toMatchObject({ status: 422 });
  });
});

describe('cross-tenant isolation', () => {
  it("org B's token cannot confirm org A's intent, and statement and invoice tokens do not cross", async () => {
    const { deps, intents } = fakeStripe();
    await onlinePaymentService.startInvoicePayment(token, deps);
    const intentId = [...intents.keys()][0] ?? '';

    const userB = await createUserWithOrg({ label: 'pubinv-b', orgName: 'Bravo' });
    const agentB = await loginAgent(app, userB);
    const customerB = await createCustomer(agentB, 'Bravo Customer', 'b@bravo.test');
    const invB = await issueInvoice(agentB, userB.orgId, customerB, 4200, '2026-06-01', '2026-06-30');
    await enableOnlinePayments(agentB, userB.orgId);
    const tokenB = await sendInvoiceLink(agentB, invB.id, 'b@bravo.test');

    await expect(onlinePaymentService.confirmFromInvoiceLink(tokenB, intentId, deps)).rejects.toMatchObject({ status: 404 });

    const stmt = await agentA.post('/api/v1/statements/customers/send').send({ partyIds: [customerId] });
    expect(stmt.status).toBe(201);
    const stmtToken = (await latestEmailLink('ap@northwind.test', 'party_statement')).pathname.split('/').pop() ?? '';
    expect((await request(app).get(`${PUBLIC}/${stmtToken}`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/public/statements/${token}`)).status).toBe(404);
  });
});

describe('online_payments source constraint', () => {
  it('rejects a row with both source ids and a row with neither (23514)', async () => {
    const { rows: sends } = await pool.query<{ id: string }>('SELECT id FROM invoice_sends WHERE org_id = $1', [orgA]);
    const sendId = sends[0]?.id ?? '';
    const insert = (statementSendId: string | null, invoiceSendId: string | null) =>
      pool.query(
        `INSERT INTO online_payments (org_id, statement_send_id, invoice_send_id, customer_id, currency_code, amount_cents)
         VALUES ($1, $2, $3, $4, 'USD', 100)`,
        [orgA, statementSendId, invoiceSendId, customerId],
      );
    await expect(insert(null, null)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(sendId, sendId)).rejects.toMatchObject({ code: '23514' });
  });
});
