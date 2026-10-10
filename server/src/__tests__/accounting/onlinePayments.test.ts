import { createHmac } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import * as onlinePaymentService from '../../services/accounting/onlinePaymentService.js';
import { resolveLiveSend } from '../../services/accounting/statementLinkService.js';
import type { StripeDeps } from '../../services/payments/stripeClient.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { latestEmailLink } from '../helpers/email.js';
import {
  accountId,
  createCustomer,
  issueInvoice,
  receivePayment,
  type Agent,
} from '../helpers/accountingFixtures.js';

/**
 * Paying a statement online through Stripe (Phase 39c). Integration tier,
 * real PostgreSQL, with Stripe replaced by an in-memory fake injected through
 * `deps` (the Drive integration's pattern) — no network, no keys.
 *
 * The claims: the server, not the browser, decides the amount; a succeeded
 * intent becomes exactly one ordinary receipt however many times and in
 * whatever order the webhook and the browser report it; money that cannot be
 * applied lands in NEEDS_REVIEW, never silently.
 */

const app = createApp();
const WEBHOOK_SECRET = 'whsec_test_secret';

let userA: SeededUser;
let orgA: string;
let agentA: Agent;
let customerId: string;
let inv1: string;
let inv2: string;

interface FakeIntent {
  id: string;
  status: string;
  amount: number;
  currency: string;
  client_secret: string;
  metadata: Record<string, string>;
  last_payment_error: { message: string } | null;
}

/** An in-memory Stripe: enough of /v1/payment_intents for the service. */
function fakeStripe() {
  const intents = new Map<string, FakeIntent>();
  const requests: { method: string; url: string; headers: Record<string, string>; body: URLSearchParams | null }[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === 'string' ? new URLSearchParams(init.body) : null;
    requests.push({ method, url, headers, body });
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

async function enableOnlinePayments(agent: Agent, orgId: string): Promise<void> {
  const res = await agent
    .patch('/api/v1/settings/online-payments')
    .send({ enabled: true, depositAccountId: await accountId(orgId, '1110') });
  if (res.status !== 200) throw new Error(`fixture: enable failed ${res.status} ${JSON.stringify(res.body)}`);
}

async function sendStatement(agent: Agent, partyId: string, email: string): Promise<string> {
  const res = await agent.post('/api/v1/statements/customers/send').send({ partyIds: [partyId] });
  if (res.status !== 201) throw new Error(`fixture: send failed ${res.status}`);
  const url = await latestEmailLink(email, 'party_statement');
  return url.pathname.split('/').pop() ?? '';
}

async function cardPayments(orgId: string): Promise<{ id: string; amount_cents: string; reference: string }[]> {
  const { rows } = await pool.query<{ id: string; amount_cents: string; reference: string }>(
    `SELECT id, amount_cents::text AS amount_cents, reference FROM payments
      WHERE org_id = $1 AND method = 'CARD' AND status = 'POSTED'`,
    [orgId],
  );
  return rows;
}

let token: string;

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'pay-a', orgName: 'Harbor Point' });
  orgA = userA.orgId;
  agentA = await loginAgent(app, userA);
  customerId = await createCustomer(agentA, 'Northwind Traders', 'ap@northwind.test');
  inv1 = (await issueInvoice(agentA, orgA, customerId, 10000, '2026-06-01', '2026-06-30')).id;
  inv2 = (await issueInvoice(agentA, orgA, customerId, 5000, '2026-06-15', '2026-07-15')).id;
  await receivePayment(agentA, orgA, customerId, '2026-06-20', [{ invoiceId: inv1, amountCents: 3000 }]);
  await enableOnlinePayments(agentA, orgA);
  token = await sendStatement(agentA, customerId, 'ap@northwind.test');
});

afterAll(closePool);

describe('online payment settings', () => {
  it('needs an active postable Asset account to turn on; VIEWER cannot change it', async () => {
    const off = await agentA.patch('/api/v1/settings/online-payments').send({ enabled: false, depositAccountId: null });
    expect(off.body.onlinePaymentSettings).toMatchObject({ enabled: false, depositAccountId: null });
    expect((await agentA.patch('/api/v1/settings/online-payments').send({ enabled: true })).status).toBe(422);
    const { rows: liabilities } = await pool.query<{ id: string }>(
      "SELECT id FROM accounts WHERE org_id = $1 AND type = 'Liability' AND is_postable LIMIT 1",
      [orgA],
    );
    const liability = await agentA
      .patch('/api/v1/settings/online-payments')
      .send({ enabled: true, depositAccountId: liabilities[0]?.id });
    expect(liability.status).toBe(422);

    const viewer = await createUserWithOrg({ label: 'pay-viewer', orgName: 'Viewer Solo' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, viewer);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });
    expect((await agent.get('/api/v1/settings/online-payments')).status).toBe(200);
    expect((await agent.patch('/api/v1/settings/online-payments').send({ enabled: false })).status).toBe(403);
  });

  it('the link offers card payment only when the org enabled it and Stripe is configured', async () => {
    const { deps } = fakeStripe();
    const send = await resolveLiveSend(token);
    expect(await onlinePaymentService.paymentOptionsFor(send, deps)).toEqual({ enabled: true, publishableKey: 'pk_test_fake' });
    expect(await onlinePaymentService.paymentOptionsFor(send, { config: null })).toEqual({ enabled: false, publishableKey: null });
    await agentA.patch('/api/v1/settings/online-payments').send({ enabled: false });
    expect((await onlinePaymentService.paymentOptionsFor(send, deps)).enabled).toBe(false);
  });
});

describe('startPayment', () => {
  it('charges what the server says is outstanding, idempotency-keyed, and stores what was chosen', async () => {
    const { deps, requests } = fakeStripe();
    const started = await onlinePaymentService.startPayment(token, [inv1, inv2], deps);
    expect(started).toMatchObject({ amountCents: 12000, currencyCode: 'USD', publishableKey: 'pk_test_fake' });
    expect(started.clientSecret).toMatch(/^pi_fake1_secret_/);

    const create = requests.find((r) => r.method === 'POST');
    expect(create?.body?.get('amount')).toBe('12000');
    expect(create?.body?.get('currency')).toBe('usd');
    expect(create?.headers['Idempotency-Key']).toBe(`online-payment-${started.onlinePaymentId}`);
    expect(create?.headers.Authorization).toBe('Bearer sk_test_fake');

    const { rows } = await pool.query<{ invoice_id: string; amount_cents: string }>(
      'SELECT invoice_id, amount_cents::text AS amount_cents FROM online_payment_invoices ORDER BY amount_cents',
    );
    expect(rows).toEqual([
      { invoice_id: inv2, amount_cents: '5000' },
      { invoice_id: inv1, amount_cents: '7000' },
    ]);
  });

  it("refuses another customer's invoice (404), a paid invoice (422), nothing chosen (422), and when disabled (409)", async () => {
    const { deps } = fakeStripe();
    const other = await createCustomer(agentA, 'Contoso', 'c@contoso.test');
    const otherInv = (await issueInvoice(agentA, orgA, other, 100, '2026-06-01', '2026-06-30')).id;
    await expect(onlinePaymentService.startPayment(token, [otherInv], deps)).rejects.toMatchObject({ status: 404 });

    await receivePayment(agentA, orgA, customerId, '2026-06-21', [{ invoiceId: inv2, amountCents: 5000 }]);
    await expect(onlinePaymentService.startPayment(token, [inv2], deps)).rejects.toMatchObject({ status: 422 });
    await expect(onlinePaymentService.startPayment(token, [], deps)).rejects.toMatchObject({ status: 422 });

    await agentA.patch('/api/v1/settings/online-payments').send({ enabled: false });
    await expect(onlinePaymentService.startPayment(token, [inv1], deps)).rejects.toMatchObject({ status: 409 });
  });

  it('over HTTP, without Stripe configured, the link says payment is unavailable (409)', async () => {
    const res = await request(app).post(`/api/v1/public/statements/${token}/payments`).send({ invoiceIds: [inv1] });
    expect(res.status).toBe(409);
  });
});

describe('settleIntent', () => {
  it('a succeeded intent becomes one CARD receipt settling the invoices; repeating it changes nothing', async () => {
    const { deps, intents } = fakeStripe();
    const started = await onlinePaymentService.startPayment(token, [inv1, inv2], deps);
    const intentId = [...intents.keys()][0] ?? '';

    expect(await onlinePaymentService.settleIntent(intentId, deps)).toEqual({ status: 'PENDING', paymentId: null });
    const intent = intents.get(intentId);
    if (intent !== undefined) intent.status = 'succeeded';

    const first = await onlinePaymentService.settleIntent(intentId, deps);
    expect(first.status).toBe('RECORDED');
    const again = await onlinePaymentService.settleIntent(intentId, deps);
    expect(again).toEqual(first);

    const payments = await cardPayments(orgA);
    expect(payments).toEqual([{ id: first.paymentId, amount_cents: '12000', reference: intentId }]);
    const open = await agentA.get(`/api/v1/customers/${customerId}/open-items`);
    expect(open.body.outstandingCents).toBe(0);

    const listed = await agentA.get('/api/v1/online-payments?status=RECORDED');
    expect(listed.body.onlinePayments).toEqual([
      expect.objectContaining({ id: started.onlinePaymentId, status: 'RECORDED', amountCents: 12000, paymentId: first.paymentId }),
    ]);
  });

  it('webhook and browser confirm racing record exactly one payment', async () => {
    const { deps, intents } = fakeStripe();
    await onlinePaymentService.startPayment(token, [inv1], deps);
    const intentId = [...intents.keys()][0] ?? '';
    const intent = intents.get(intentId);
    if (intent !== undefined) intent.status = 'succeeded';

    const body = event('payment_intent.succeeded', intentId);
    await Promise.all([
      onlinePaymentService.confirmFromLink(token, intentId, deps),
      onlinePaymentService.handleWebhook(Buffer.from(body), sign(body), deps),
      onlinePaymentService.settleIntent(intentId, deps),
    ]);
    expect(await cardPayments(orgA)).toHaveLength(1);
  });

  it('money that cannot be applied (invoice paid meanwhile) goes to NEEDS_REVIEW with no receipt', async () => {
    const { deps, intents } = fakeStripe();
    await onlinePaymentService.startPayment(token, [inv2], deps);
    await receivePayment(agentA, orgA, customerId, '2026-06-22', [{ invoiceId: inv2, amountCents: 5000 }]);
    const intentId = [...intents.keys()][0] ?? '';
    const intent = intents.get(intentId);
    if (intent !== undefined) intent.status = 'succeeded';

    const result = await onlinePaymentService.settleIntent(intentId, deps);
    expect(result).toEqual({ status: 'NEEDS_REVIEW', paymentId: null });
    expect(await cardPayments(orgA)).toHaveLength(0);
    const listed = await agentA.get('/api/v1/online-payments?status=NEEDS_REVIEW');
    expect(listed.body.onlinePayments[0].failureReason).toEqual(expect.any(String));
  });

  it('a charged amount that differs from ours goes to NEEDS_REVIEW', async () => {
    const { deps, intents } = fakeStripe();
    await onlinePaymentService.startPayment(token, [inv1], deps);
    const intent = [...intents.values()][0];
    if (intent !== undefined) {
      intent.status = 'succeeded';
      intent.amount = 1;
    }
    expect((await onlinePaymentService.settleIntent(intent?.id ?? '', deps)).status).toBe('NEEDS_REVIEW');
  });

  it('a declined card keeps the payment PENDING and records why; canceled is terminal', async () => {
    const { deps, intents } = fakeStripe();
    const started = await onlinePaymentService.startPayment(token, [inv1], deps);
    const intent = [...intents.values()][0];
    if (intent !== undefined) intent.last_payment_error = { message: 'Your card was declined.' };
    expect((await onlinePaymentService.settleIntent(intent?.id ?? '', deps)).status).toBe('PENDING');
    const { rows } = await pool.query<{ failure_reason: string }>('SELECT failure_reason FROM online_payments WHERE id = $1', [
      started.onlinePaymentId,
    ]);
    expect(rows[0]?.failure_reason).toBe('Your card was declined.');

    if (intent !== undefined) intent.status = 'canceled';
    expect((await onlinePaymentService.settleIntent(intent?.id ?? '', deps)).status).toBe('CANCELED');
    if (intent !== undefined) intent.status = 'succeeded';
    expect((await onlinePaymentService.settleIntent(intent?.id ?? '', deps)).status).toBe('CANCELED');
    expect(await cardPayments(orgA)).toHaveLength(0);
  });
});

describe('the Stripe webhook', () => {
  it('rejects a wrong signature, a stale timestamp, and a missing header', async () => {
    const { deps } = fakeStripe();
    const body = event('payment_intent.succeeded', 'pi_fake1');
    await expect(
      onlinePaymentService.handleWebhook(Buffer.from(body), sign(body, 'whsec_wrong'), deps),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      onlinePaymentService.handleWebhook(Buffer.from(body), sign(body, WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 3600), deps),
    ).rejects.toMatchObject({ status: 400 });
    await expect(onlinePaymentService.handleWebhook(Buffer.from(body), undefined, deps)).rejects.toMatchObject({ status: 400 });
    // A body altered after signing no longer verifies.
    await expect(
      onlinePaymentService.handleWebhook(Buffer.from(body.replace('succeeded', 'canceled')), sign(body), deps),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("acknowledges and ignores an intent that is not ours, and event types it doesn't handle", async () => {
    const { deps } = fakeStripe();
    const unknown = event('payment_intent.succeeded', 'pi_notours');
    await expect(onlinePaymentService.handleWebhook(Buffer.from(unknown), sign(unknown), deps)).resolves.toBeUndefined();
    const other = event('charge.refunded', 'ch_1');
    await expect(onlinePaymentService.handleWebhook(Buffer.from(other), sign(other), deps)).resolves.toBeUndefined();
  });

  it('the route receives the raw body (not parsed JSON)', async () => {
    const body = event('payment_intent.succeeded', 'pi_fake1');
    const res = await request(app)
      .post('/api/v1/public/stripe/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', sign(body))
      .send(body);
    expect(res.body.error).not.toBe('Webhook body must be raw JSON');
    expect([400, 503]).toContain(res.status);
  });
});

describe('cross-tenant isolation', () => {
  it("one link cannot confirm another org's intent; org B never lists org A's online payments", async () => {
    const { deps, intents } = fakeStripe();
    await onlinePaymentService.startPayment(token, [inv1], deps);
    const intentId = [...intents.keys()][0] ?? '';

    const userB = await createUserWithOrg({ label: 'pay-b', orgName: 'Bravo' });
    const agentB = await loginAgent(app, userB);
    const customerB = await createCustomer(agentB, 'Bravo Customer', 'b@bravo.test');
    await issueInvoice(agentB, userB.orgId, customerB, 4200, '2026-06-01', '2026-06-30');
    await enableOnlinePayments(agentB, userB.orgId);
    const tokenB = await sendStatement(agentB, customerB, 'b@bravo.test');

    await expect(onlinePaymentService.confirmFromLink(tokenB, intentId, deps)).rejects.toMatchObject({ status: 404 });
    await expect(onlinePaymentService.startPayment(tokenB, [inv1], deps)).rejects.toMatchObject({ status: 404 });
    expect((await agentB.get('/api/v1/online-payments')).body.onlinePayments).toEqual([]);
    expect((await agentA.get('/api/v1/online-payments')).body.onlinePayments).toHaveLength(1);
  });
});
