import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId, createCustomer, type Agent } from '../helpers/accountingFixtures.js';

/**
 * Phase 42 (Slice F) — sales and purchase orders with partial invoicing and
 * billing. Integration tier, real PostgreSQL.
 *
 * The central claims: an order never touches the ledger; a number is
 * allocated at confirmation; billed quantity is derived from live
 * (non-VOID) linked document lines and never exceeds what was ordered —
 * through the service and, at COMMIT, through the database; and none of it
 * is visible across tenants.
 */

const app = createApp();
const ORDERS = '/api/v1/orders';
const PURCHASE_ORDERS = '/api/v1/purchase-orders';
const QUOTES = '/api/v1/quotes';
const INVOICES = '/api/v1/invoices';
const BILLS = '/api/v1/bills';

const DAY_MS = 24 * 60 * 60 * 1000;
function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
}
const TODAY = isoDaysFromNow(0);

let userA: SeededUser;
let userB: SeededUser;
let agentA: Agent;
let agentB: Agent;
let customerA: string;
let vendorA: string;

async function createVendor(agent: Agent, name: string): Promise<string> {
  const res = await agent.post('/api/v1/vendors').send({ name });
  if (res.status !== 201) throw new Error(`fixture: vendor create failed ${res.status} ${res.text}`);
  return res.body.vendor.id as string;
}

/** Five units at 100.00, no tax: 500.00. */
async function salesOrderPayload(orgId: string, partyId: string, extra: Record<string, unknown> = {}) {
  return {
    partyId,
    orderDate: TODAY,
    lines: [
      {
        description: 'Widget',
        quantityMilli: 5000,
        unitPriceCents: 10000,
        accountId: await accountId(orgId, '4100'),
        taxRateBp: 0,
      },
    ],
    ...extra,
  };
}

async function purchaseOrderPayload(orgId: string, partyId: string) {
  return {
    partyId,
    orderDate: TODAY,
    lines: [
      {
        description: 'Steel sheet',
        quantityMilli: 5000,
        unitPriceCents: 2000,
        accountId: await accountId(orgId, '6130'),
        taxRateBp: 0,
      },
    ],
  };
}

async function draftOrder(agent: Agent, base: string, payload: object) {
  const res = await agent.post(base).send(payload);
  if (res.status !== 201) throw new Error(`fixture: order create failed ${res.status} ${res.text}`);
  return res.body.order as { id: string };
}

async function confirmedOrder(agent: Agent, base: string, payload: object) {
  const draft = await draftOrder(agent, base, payload);
  const res = await agent.post(`${base}/${draft.id}/confirm`).send({});
  if (res.status !== 200) throw new Error(`fixture: order confirm failed ${res.status} ${res.text}`);
  return res.body.order as {
    id: string;
    orderNumber: string;
    status: string;
    billingStatus: string;
    lines: { id: string; billedQuantityMilli: number; remainingQuantityMilli: number }[];
  };
}

async function getOrder(agent: Agent, base: string, id: string) {
  const res = await agent.get(`${base}/${id}`);
  expect(res.status).toBe(200);
  return res.body.order as {
    status: string;
    billingStatus: string;
    lines: { id: string; billedQuantityMilli: number; remainingQuantityMilli: number }[];
    documents: { kind: string; id: string; number: string | null; status: string }[];
    sourceQuote: { id: string } | null;
  };
}

async function ledgerRowCount(orgId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT (SELECT count(*) FROM journal_entries WHERE org_id = $1) + (SELECT count(*) FROM ledger_lines WHERE org_id = $1) AS n`,
    [orgId],
  );
  return Number(rows[0]?.n ?? '0');
}

async function convert(agent: Agent, base: string, id: string, body: object = {}) {
  return agent.post(`${base}/${id}/convert`).send(body);
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  customerA = await createCustomer(agentA, 'Acme Fitouts', 'buyer@acme.test');
  vendorA = await createVendor(agentA, 'Steel Co');
});

afterAll(closePool);

describe('orders — lifecycle', () => {
  it('create -> confirm numbers SO-000001 (PO-000001 for purchase)', async () => {
    const draft = await agentA.post(ORDERS).send(await salesOrderPayload(userA.orgId, customerA));
    expect(draft.status).toBe(201);
    expect(draft.body.order).toMatchObject({ status: 'DRAFT', orderNumber: null, totalCents: 50000 });

    const confirmed = await confirmedOrder(agentA, ORDERS, await salesOrderPayload(userA.orgId, customerA));
    expect(confirmed).toMatchObject({ status: 'CONFIRMED', billingStatus: 'NOT_BILLED' });
    // The first draft above was never confirmed, so it burned no number.
    expect(confirmed.orderNumber).toBe('SO-000001');

    const purchase = await confirmedOrder(agentA, PURCHASE_ORDERS, await purchaseOrderPayload(userA.orgId, vendorA));
    expect(purchase.orderNumber).toBe('PO-000001');
  });

  it('cancel with a live invoice -> 409; after voiding it -> 200 CANCELLED', async () => {
    const order = await confirmedOrder(agentA, ORDERS, await salesOrderPayload(userA.orgId, customerA));
    const invoiceId = (await convert(agentA, ORDERS, order.id)).body.document.id as string;
    const issued = await agentA.post(`${INVOICES}/${invoiceId}/issue`).send({});
    expect(issued.status).toBe(200);

    const refused = await agentA.post(`${ORDERS}/${order.id}/cancel`).send({ reason: 'Customer withdrew' });
    expect(refused.status).toBe(409);
    expect(refused.body.error ?? refused.body.message).toMatch(/Void the invoices raised against this order first/);

    expect((await agentA.post(`${INVOICES}/${invoiceId}/void`).send({})).status).toBe(200);
    const cancelled = await agentA.post(`${ORDERS}/${order.id}/cancel`).send({ reason: 'Customer withdrew' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.order).toMatchObject({ status: 'CANCELLED', cancelReason: 'Customer withdrew' });
  });

  it('close then reopen', async () => {
    const order = await confirmedOrder(agentA, ORDERS, await salesOrderPayload(userA.orgId, customerA));
    const closed = await agentA.post(`${ORDERS}/${order.id}/close`).send({});
    expect(closed.status).toBe(200);
    expect(closed.body.order.status).toBe('CLOSED');
    // A closed order cannot be invoiced.
    expect((await convert(agentA, ORDERS, order.id)).status).toBe(409);
    const reopened = await agentA.post(`${ORDERS}/${order.id}/reopen`).send({});
    expect(reopened.status).toBe(200);
    expect(reopened.body.order.status).toBe('CONFIRMED');
    expect((await convert(agentA, ORDERS, order.id)).status).toBe(201);
  });
});

describe('orders — partial billing', () => {
  it('convert 2 of 5 units -> DRAFT invoice with orderLineId; order PARTIALLY_BILLED, remaining 3', async () => {
    const order = await confirmedOrder(agentA, ORDERS, await salesOrderPayload(userA.orgId, customerA));
    const lineId = order.lines[0]!.id;
    const res = await convert(agentA, ORDERS, order.id, { lines: [{ orderLineId: lineId, quantityMilli: 2000 }] });
    expect(res.status).toBe(201);
    expect(res.body.document.kind).toBe('INVOICE');

    const invoice = (await agentA.get(`${INVOICES}/${res.body.document.id}`)).body.invoice;
    expect(invoice.status).toBe('DRAFT');
    expect(invoice.lines[0]).toMatchObject({ orderLineId: lineId, quantityMilli: 2000 });

    const after = await getOrder(agentA, ORDERS, order.id);
    expect(after.billingStatus).toBe('PARTIALLY_BILLED');
    expect(after.lines[0]).toMatchObject({ billedQuantityMilli: 2000, remainingQuantityMilli: 3000 });
    expect(after.documents).toEqual([expect.objectContaining({ kind: 'INVOICE', status: 'DRAFT' })]);
  });

  it('convert with lines null bills the remaining 3 -> FULLY_BILLED', async () => {
    const order = await confirmedOrder(agentA, ORDERS, await salesOrderPayload(userA.orgId, customerA));
    const lineId = order.lines[0]!.id;
    await convert(agentA, ORDERS, order.id, { lines: [{ orderLineId: lineId, quantityMilli: 2000 }] });
    const res = await convert(agentA, ORDERS, order.id, { lines: null });
    expect(res.status).toBe(201);
    const invoice = (await agentA.get(`${INVOICES}/${res.body.document.id}`)).body.invoice;
    expect(invoice.lines[0]).toMatchObject({ quantityMilli: 3000 });

    const after = await getOrder(agentA, ORDERS, order.id);
    expect(after.billingStatus).toBe('FULLY_BILLED');
    expect(after.lines[0]).toMatchObject({ billedQuantityMilli: 5000, remainingQuantityMilli: 0 });
    // Nothing left to bill.
    expect((await convert(agentA, ORDERS, order.id)).status).toBe(409);
  });

  it('asking for more than remaining -> 422 Line 1 has only 3 left to bill', async () => {
    const order = await confirmedOrder(agentA, ORDERS, await salesOrderPayload(userA.orgId, customerA));
    const lineId = order.lines[0]!.id;
    await convert(agentA, ORDERS, order.id, { lines: [{ orderLineId: lineId, quantityMilli: 2000 }] });
    const res = await convert(agentA, ORDERS, order.id, { lines: [{ orderLineId: lineId, quantityMilli: 4000 }] });
    expect(res.status).toBe(422);
    expect(res.text).toContain('Line 1 has only 3 left to bill');
  });

  it('editing the draft invoice to 6 units -> 422 from the deferred cap', async () => {
    const order = await confirmedOrder(agentA, ORDERS, await salesOrderPayload(userA.orgId, customerA));
    const lineId = order.lines[0]!.id;
    const invoiceId = (await convert(agentA, ORDERS, order.id, { lines: [{ orderLineId: lineId, quantityMilli: 2000 }] }))
      .body.document.id as string;
    const invoice = (await agentA.get(`${INVOICES}/${invoiceId}`)).body.invoice;

    const edit = (quantityMilli: number) =>
      agentA.patch(`${INVOICES}/${invoiceId}`).send({
        customerId: customerA,
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
        notes: null,
        paymentTerms: null,
        lines: [
          {
            description: 'Widget',
            quantityMilli,
            unitPriceCents: 10000,
            revenueAccountId: invoice.lines[0].revenueAccountId,
            taxRateBp: 0,
            orderLineId: lineId,
          },
        ],
      });

    const tooMany = await edit(6000);
    expect(tooMany.status).toBe(422);
    expect(tooMany.text).toMatch(/billed beyond its ordered quantity/);
    // The refused edit left the draft as it was; 5 is allowed.
    expect((await getOrder(agentA, ORDERS, order.id)).lines[0]).toMatchObject({ billedQuantityMilli: 2000 });
    expect((await edit(5000)).status).toBe(200);
    expect((await getOrder(agentA, ORDERS, order.id)).lines[0]).toMatchObject({ remainingQuantityMilli: 0 });
  });

  it('deleting the draft invoice restores remaining', async () => {
    const order = await confirmedOrder(agentA, ORDERS, await salesOrderPayload(userA.orgId, customerA));
    const invoiceId = (await convert(agentA, ORDERS, order.id)).body.document.id as string;
    expect((await getOrder(agentA, ORDERS, order.id)).billingStatus).toBe('FULLY_BILLED');

    expect((await agentA.delete(`${INVOICES}/${invoiceId}`)).status).toBe(204);
    const after = await getOrder(agentA, ORDERS, order.id);
    expect(after.billingStatus).toBe('NOT_BILLED');
    expect(after.lines[0]).toMatchObject({ billedQuantityMilli: 0, remainingQuantityMilli: 5000 });
  });

  it('voiding an issued invoice restores remaining', async () => {
    const order = await confirmedOrder(agentA, ORDERS, await salesOrderPayload(userA.orgId, customerA));
    const invoiceId = (await convert(agentA, ORDERS, order.id)).body.document.id as string;
    expect((await agentA.post(`${INVOICES}/${invoiceId}/issue`).send({})).status).toBe(200);
    expect((await getOrder(agentA, ORDERS, order.id)).lines[0]).toMatchObject({ remainingQuantityMilli: 0 });

    expect((await agentA.post(`${INVOICES}/${invoiceId}/void`).send({})).status).toBe(200);
    const after = await getOrder(agentA, ORDERS, order.id);
    expect(after.billingStatus).toBe('NOT_BILLED');
    expect(after.lines[0]).toMatchObject({ billedQuantityMilli: 0, remainingQuantityMilli: 5000 });
  });

  it('purchase order -> two partial bills get vendor references PO-000001-1 and PO-000001-2', async () => {
    const order = await confirmedOrder(agentA, PURCHASE_ORDERS, await purchaseOrderPayload(userA.orgId, vendorA));
    const lineId = order.lines[0]!.id;
    const first = await convert(agentA, PURCHASE_ORDERS, order.id, { lines: [{ orderLineId: lineId, quantityMilli: 2000 }] });
    expect(first.status).toBe(201);
    expect(first.body.document.kind).toBe('BILL');
    const second = await convert(agentA, PURCHASE_ORDERS, order.id, { lines: null });
    expect(second.status).toBe(201);

    const refs = await Promise.all(
      [first, second].map(async (r) => (await agentA.get(`${BILLS}/${r.body.document.id}`)).body.bill.vendorReference),
    );
    expect(refs).toEqual(['PO-000001-1', 'PO-000001-2']);
    expect((await getOrder(agentA, PURCHASE_ORDERS, order.id)).billingStatus).toBe('FULLY_BILLED');
  });
});

describe('orders — from a quote', () => {
  it('quote with target ORDER -> CONFIRMED order with sourceQuote; quote CONVERTED; convertedDocument kind ORDER', async () => {
    const created = await agentA.post(QUOTES).send({
      partyId: customerA,
      quoteDate: TODAY,
      validUntil: isoDaysFromNow(30),
      lines: [
        {
          description: 'Installation',
          quantityMilli: 2000,
          unitPriceCents: 10000,
          accountId: await accountId(userA.orgId, '4100'),
          taxRateBp: 1500,
        },
      ],
    });
    expect(created.status).toBe(201);
    const quoteId = created.body.quote.id as string;
    expect((await agentA.post(`${QUOTES}/${quoteId}/send`).send({ delivery: 'MANUAL' })).status).toBe(200);
    expect((await agentA.post(`${QUOTES}/${quoteId}/accept`).send({ signerName: 'Jane Doe' })).status).toBe(200);

    const res = await agentA.post(`${QUOTES}/${quoteId}/convert`).send({ target: 'ORDER' });
    expect(res.status).toBe(201);
    expect(res.body.document.kind).toBe('ORDER');

    const order = await getOrder(agentA, ORDERS, res.body.document.id as string);
    expect(order.status).toBe('CONFIRMED');
    expect(order.sourceQuote).toMatchObject({ id: quoteId });
    expect(order.lines[0]).toMatchObject({ remainingQuantityMilli: 2000 });

    const quote = (await agentA.get(`${QUOTES}/${quoteId}`)).body.quote;
    expect(quote.status).toBe('CONVERTED');
    expect(quote.convertedDocument).toMatchObject({ kind: 'ORDER', id: res.body.document.id });

    // Cancelling the order does not revert the quote.
    expect((await agentA.post(`${ORDERS}/${res.body.document.id}/cancel`).send({ reason: 'Changed mind' })).status).toBe(200);
    expect((await agentA.get(`${QUOTES}/${quoteId}`)).body.quote.status).toBe('CONVERTED');
  });
});

describe('orders — ledger and permissions', () => {
  it('no journal rows are written by any order action', async () => {
    const before = await ledgerRowCount(userA.orgId);
    const order = await confirmedOrder(agentA, ORDERS, await salesOrderPayload(userA.orgId, customerA));
    const draft = await draftOrder(agentA, ORDERS, await salesOrderPayload(userA.orgId, customerA));
    expect((await agentA.patch(`${ORDERS}/${draft.id}`).send(await salesOrderPayload(userA.orgId, customerA))).status).toBe(200);
    expect((await agentA.delete(`${ORDERS}/${draft.id}`)).status).toBe(204);
    const invoiceId = (await convert(agentA, ORDERS, order.id, { lines: null })).body.document.id as string;
    expect((await agentA.delete(`${INVOICES}/${invoiceId}`)).status).toBe(204);
    await agentA.post(`${ORDERS}/${order.id}/close`).send({});
    await agentA.post(`${ORDERS}/${order.id}/reopen`).send({});
    expect((await agentA.post(`${ORDERS}/${order.id}/cancel`).send({ reason: 'x' })).status).toBe(200);
    expect(await ledgerRowCount(userA.orgId)).toBe(before);
  });

  it('a VIEWER can read, not create or convert -> 403', async () => {
    const order = await confirmedOrder(agentA, ORDERS, await salesOrderPayload(userA.orgId, customerA));
    const viewer = await createUserWithOrg({ label: 'viewer' });
    await addMember(userA.orgId, viewer.id, 'VIEWER');
    const agentV = await loginAgent(app, viewer);
    await agentV.post('/api/v1/auth/switch-org').send({ orgId: userA.orgId });
    expect((await agentV.get(`${ORDERS}/${order.id}`)).status).toBe(200);
    expect((await agentV.get(ORDERS)).status).toBe(200);
    expect((await agentV.post(ORDERS).send(await salesOrderPayload(userA.orgId, customerA))).status).toBe(403);
    expect((await convert(agentV, ORDERS, order.id)).status).toBe(403);
  });
});

describe('orders — cross-tenant isolation', () => {
  it("org B gets 404 on every order route for org A's order, and 422 Order line not found linking A's line", async () => {
    const sales = await confirmedOrder(agentA, ORDERS, await salesOrderPayload(userA.orgId, customerA));
    const purchase = await confirmedOrder(agentA, PURCHASE_ORDERS, await purchaseOrderPayload(userA.orgId, vendorA));

    expect((await agentB.get(ORDERS)).body.totalCount).toBe(0);
    expect((await agentB.get(PURCHASE_ORDERS)).body.totalCount).toBe(0);
    for (const [base, id] of [
      [ORDERS, sales.id],
      [PURCHASE_ORDERS, purchase.id],
    ] as const) {
      expect((await agentB.get(`${base}/${id}`)).status).toBe(404);
      expect((await agentB.patch(`${base}/${id}`).send({})).status).toBeGreaterThanOrEqual(400);
      expect((await agentB.delete(`${base}/${id}`)).status).toBe(404);
      expect((await agentB.post(`${base}/${id}/confirm`).send({})).status).toBe(404);
      expect((await agentB.post(`${base}/${id}/close`).send({})).status).toBe(404);
      expect((await agentB.post(`${base}/${id}/reopen`).send({})).status).toBe(404);
      expect((await agentB.post(`${base}/${id}/cancel`).send({ reason: 'x' })).status).toBe(404);
      expect((await agentB.post(`${base}/${id}/convert`).send({})).status).toBe(404);
    }
    // A direction mismatch is a 404 too.
    expect((await agentA.get(`${PURCHASE_ORDERS}/${sales.id}`)).status).toBe(404);

    // Org B's own invoice cannot name org A's order line.
    const customerB = await createCustomer(agentB, 'Bravo Buyer', 'b@bravo.test');
    const res = await agentB.post(INVOICES).send({
      customerId: customerB,
      issueDate: TODAY,
      dueDate: isoDaysFromNow(30),
      notes: null,
      paymentTerms: null,
      lines: [
        {
          description: 'Stolen',
          quantityMilli: 1000,
          unitPriceCents: 100,
          revenueAccountId: await accountId(userB.orgId, '4100'),
          taxRateBp: 0,
          orderLineId: sales.lines[0]!.id,
        },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.text).toContain('Order line not found');
    // And org A's order is unchanged.
    expect((await getOrder(agentA, ORDERS, sales.id)).lines[0]).toMatchObject({ billedQuantityMilli: 0 });
  });
});
