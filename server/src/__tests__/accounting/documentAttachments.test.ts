import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { clearStorage, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId, type Agent } from '../helpers/accountingFixtures.js';
import { confirmedOrder, createVendor, TODAY } from '../helpers/depositFixtures.js';

/**
 * Phase 43b — vault documents linked in the bill's own transaction, and the
 * bill/invoice order reference. Integration tier, real PostgreSQL; includes
 * the cross-tenant and rollback cases (rule 15).
 */

const app = createApp();
const DOCS = '/api/v1/documents';

function pdf(tag: string): Buffer {
  return Buffer.from(`%PDF-1.7\n%${tag}\n`);
}

let userA: SeededUser;
let userB: SeededUser;
let agentA: Agent;
let agentB: Agent;

beforeEach(async () => {
  await resetTables();
  await clearStorage();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
});

afterAll(closePool);

async function upload(agent: Agent, name: string, tag: string): Promise<string> {
  const res = await agent.post(DOCS).attach('file', pdf(tag), name);
  if (res.status !== 201) throw new Error(`fixture: upload ${res.status} ${res.text}`);
  return res.body.document.id as string;
}

function billBody(vendorId: string, extra: Record<string, unknown>, expenseAccountId: string) {
  return {
    vendorId,
    vendorReference: `REF-${randomUUID().slice(0, 8)}`,
    billDate: TODAY,
    dueDate: TODAY,
    lines: [{ description: 'Goods', quantityMilli: 1000, unitPriceCents: 5000, expenseAccountId, taxRateBp: 0 }],
    ...extra,
  };
}

describe('attaching vault documents while drafting', () => {
  it('links the uploaded document to the new bill', async () => {
    const vendorId = await createVendor(agentA, 'Acme');
    const expense = await accountId(userA.orgId, '6130');
    const docId = await upload(agentA, 'receipt.pdf', 'one');

    const res = await agentA.post('/api/v1/bills').send(billBody(vendorId, { attachmentDocumentIds: [docId] }, expense));
    expect(res.status).toBe(201);

    const list = await agentA.get(`${DOCS}?module=ledger-core&entityType=bill&entityId=${res.body.bill.id as string}`);
    expect(list.status).toBe(200);
    expect(list.body.documents).toHaveLength(1);
    expect((list.body.documents as { id: string }[])[0]?.id).toBe(docId);
  });

  it("another organization's document id is refused and the whole bill rolls back", async () => {
    const vendorId = await createVendor(agentA, 'Acme');
    const expense = await accountId(userA.orgId, '6130');
    const mine = await upload(agentA, 'mine.pdf', 'mine');
    const theirs = await upload(agentB, 'theirs.pdf', 'theirs');

    const before = await agentA.get('/api/v1/bills');
    const res = await agentA
      .post('/api/v1/bills')
      .send(billBody(vendorId, { attachmentDocumentIds: [mine, theirs] }, expense));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Document not found');

    const after = await agentA.get('/api/v1/bills');
    expect(after.body.count).toBe(before.body.count);
    const links = await agentA.get(`${DOCS}/${mine}`);
    expect(links.body.document.links).toHaveLength(0);
  });

  it('?unattached=true hides a linked document and ?q= filters by filename', async () => {
    const vendorId = await createVendor(agentA, 'Acme');
    const expense = await accountId(userA.orgId, '6130');
    const free = await upload(agentA, 'invoice-1.pdf', 'free');
    const linked = await upload(agentA, 'statement.pdf', 'linked');
    const bill = await agentA.post('/api/v1/bills').send(billBody(vendorId, { attachmentDocumentIds: [linked] }, expense));
    expect(bill.status).toBe(201);

    const unattached = await agentA.get(`${DOCS}?unattached=true`);
    expect((unattached.body.documents as { id: string }[]).map((d) => d.id)).toEqual([free]);

    const matched = await agentA.get(`${DOCS}?q=inv`);
    expect((matched.body.documents as { id: string }[]).map((d) => d.id)).toEqual([free]);
  });

  it('a q search treats % literally', async () => {
    await upload(agentA, 'invoice-1.pdf', 'free');
    const res = await agentA.get(`${DOCS}?q=${encodeURIComponent('%')}`);
    expect(res.status).toBe(200);
    expect(res.body.documents).toHaveLength(0);
  });

  it("a document link accepts the new 'debit_note' entity type", async () => {
    const docId = await upload(agentA, 'note.pdf', 'note');
    const res = await agentA
      .post(`${DOCS}/${docId}/links`)
      .send({ module: 'ledger-core', entityType: 'debit_note', entityId: randomUUID() });
    expect(res.status).toBe(201);
  });
});

describe('referencing a purchase order from a bill', () => {
  it('a confirmed order of the same vendor is linked and its number returned', async () => {
    const vendorId = await createVendor(agentA, 'Acme');
    const expense = await accountId(userA.orgId, '6130');
    const order = await confirmedOrder(agentA, userA.orgId, 'PURCHASE', vendorId);

    const res = await agentA.post('/api/v1/bills').send(billBody(vendorId, { purchaseOrderId: order.id }, expense));
    expect(res.status).toBe(201);
    expect(res.body.bill.purchaseOrderId).toBe(order.id);
    expect(res.body.bill.purchaseOrderNumber).toBe(order.orderNumber);
  });

  it("another vendor's order is refused", async () => {
    const vendorId = await createVendor(agentA, 'Acme');
    const otherVendor = await createVendor(agentA, 'Other Vendor');
    const expense = await accountId(userA.orgId, '6130');
    const order = await confirmedOrder(agentA, userA.orgId, 'PURCHASE', otherVendor);

    const res = await agentA.post('/api/v1/bills').send(billBody(vendorId, { purchaseOrderId: order.id }, expense));
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('That purchase order belongs to a different vendor');
  });

  it("another organization's order is 'not found'", async () => {
    const vendorA = await createVendor(agentA, 'Acme');
    const vendorB = await createVendor(agentB, 'Acme B');
    const expense = await accountId(userA.orgId, '6130');
    const orderB = await confirmedOrder(agentB, userB.orgId, 'PURCHASE', vendorB);

    const res = await agentA.post('/api/v1/bills').send(billBody(vendorA, { purchaseOrderId: orderB.id }, expense));
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Purchase order not found');
  });

  it('converting a confirmed purchase order to a bill sets purchaseOrderId', async () => {
    const vendorId = await createVendor(agentA, 'Acme');
    const order = await confirmedOrder(agentA, userA.orgId, 'PURCHASE', vendorId);

    const converted = await agentA.post(`/api/v1/purchase-orders/${order.id}/convert`).send({});
    expect(converted.status).toBe(201);
    const bill = await agentA.get(`/api/v1/bills/${converted.body.document.id as string}`);
    expect(bill.body.bill.purchaseOrderId).toBe(order.id);
    expect(bill.body.bill.purchaseOrderNumber).toBe(order.orderNumber);
  });
});
