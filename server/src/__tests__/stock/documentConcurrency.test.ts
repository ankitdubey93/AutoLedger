import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { runIntegrityChecks } from '../../db/integrity.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Phase 32 — concurrent invoice issue against shared stock. The document seam
 * locks the invoice row, then ALL stock balances in one sorted pass, then the
 * number counter, then the journal — so racing documents serialize instead of
 * deadlocking or overselling. Integration tier, real PostgreSQL.
 */

const app = createApp();
const LC = '/api/v1/ledger-core';
const STOCK = '/api/v1/stock';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let orgA: string;
let agent: Agent;

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  orgA = userA.orgId;
  agent = await loginAgent(app, userA);
});

afterAll(closePool);

async function accountId(code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id = $1 AND code = $2', [orgA, code]);
  return rows[0]?.id as string;
}

async function createProduct(name: string): Promise<{ stockItemId: string; productId: string }> {
  const { rows: cat } = await pool.query<{ id: string }>("SELECT id FROM stock_categories WHERE org_id = $1 AND code = 'GEN'", [orgA]);
  const res = await agent.post(`${STOCK}/items`).send({ name, categoryId: cat[0]?.id, attributes: {} });
  expect(res.status).toBe(201);
  return { stockItemId: res.body.item.id as string, productId: res.body.item.ledgerItemId as string };
}

async function stockUp(productId: string, quantity: number, ref: string): Promise<void> {
  const vendor = await agent.post(`${LC}/vendors`).send({ name: `V ${ref}` });
  const bill = await agent.post(`${LC}/bills`).send({
    vendorId: vendor.body.vendor.id,
    vendorReference: ref,
    billDate: '2026-03-01',
    dueDate: '2026-03-31',
    lines: [{ description: 'stock', quantityMilli: quantity * 1000, unitPriceCents: 1000, expenseAccountId: await accountId('1140'), itemId: productId }],
  });
  expect(bill.status).toBe(201);
  expect((await agent.post(`${LC}/bills/${bill.body.bill.id}/approve`).send({})).status).toBe(200);
}

async function draftInvoice(lines: { productId: string; quantity: number }[]): Promise<string> {
  const customer = await agent.post(`${LC}/customers`).send({ name: 'Northwind' });
  const revenue = await accountId('4100');
  const res = await agent.post(`${LC}/invoices`).send({
    customerId: customer.body.customer.id,
    issueDate: '2026-03-05',
    dueDate: '2026-04-04',
    lines: lines.map((l) => ({
      description: 'sale',
      quantityMilli: l.quantity * 1000,
      unitPriceCents: 2500,
      revenueAccountId: revenue,
      itemId: l.productId,
    })),
  });
  expect(res.status).toBe(201);
  return res.body.invoice.id as string;
}

describe('concurrent invoice issue', () => {
  it('two invoices racing for the last unit: exactly one wins, the other gets a 409', async () => {
    await agent.post(`${STOCK}/setup`).send({ industryProfile: 'GENERAL' });
    const item = await createProduct('Last one');
    await stockUp(item.productId, 1, 'B-1');

    const [inv1, inv2] = [await draftInvoice([{ productId: item.productId, quantity: 1 }]), await draftInvoice([{ productId: item.productId, quantity: 1 }])];
    const results = await Promise.all([
      agent.post(`${LC}/invoices/${inv1}/issue`).send({}),
      agent.post(`${LC}/invoices/${inv2}/issue`).send({}),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const { rows } = await pool.query<{ q: string }>('SELECT COALESCE(SUM(quantity_milli), 0)::text AS q FROM stock_balances WHERE org_id = $1 AND item_id = $2', [orgA, item.stockItemId]);
    expect(Number(rows[0]?.q)).toBe(0);
    expect((await runIntegrityChecks()).passed).toBe(true);
  });

  it('invoices listing the same items in opposite order never deadlock', async () => {
    await agent.post(`${STOCK}/setup`).send({ industryProfile: 'GENERAL' });
    const a = await createProduct('Item A');
    const b = await createProduct('Item B');
    await stockUp(a.productId, 20, 'B-A');
    await stockUp(b.productId, 20, 'B-B');

    const drafts: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      drafts.push(
        await draftInvoice(
          i % 2 === 0
            ? [{ productId: a.productId, quantity: 1 }, { productId: b.productId, quantity: 1 }]
            : [{ productId: b.productId, quantity: 1 }, { productId: a.productId, quantity: 1 }],
        ),
      );
    }
    const results = await Promise.all(drafts.map((id) => agent.post(`${LC}/invoices/${id}/issue`).send({})));

    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    const { rows } = await pool.query<{ q: string }>('SELECT COALESCE(SUM(quantity_milli), 0)::text AS q FROM stock_balances WHERE org_id = $1', [orgA]);
    expect(Number(rows[0]?.q)).toBe(28_000);
    expect((await runIntegrityChecks()).passed).toBe(true);
  });
});
