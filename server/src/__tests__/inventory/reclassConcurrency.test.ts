import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { runIntegrityChecks } from '../../db/integrity.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Phase 35a — a product's inventory account is changed (a reclass) while a
 * bill for the same product is approved (a stock receipt) concurrently.
 * Both paths resolve accounts before they lock balances (Core model §4), so
 * neither can deadlock the other. Integration tier, real PostgreSQL. Copies
 * the structure of documentConcurrency.test.ts.
 */

const app = createApp();
const LC = '/api/v1';
const STOCK = '/api/v1/inventory';
const ITEMS = '/api/v1/items';
const ACCOUNTS = '/api/v1/accounts';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let orgA: string;
let agent: Agent;

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'reclass-race', orgName: 'Reclass Race Org' });
  orgA = userA.orgId;
  agent = await loginAgent(app, userA);
});

afterAll(closePool);

async function accountId(code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id = $1 AND code = $2', [orgA, code]);
  return rows[0]?.id as string;
}

interface Stocked {
  stockItemId: string;
  productId: string;
}

async function createStockedItem(name: string): Promise<Stocked> {
  const { rows: cat } = await pool.query<{ id: string }>("SELECT id FROM stock_categories WHERE org_id = $1 AND code = 'GEN'", [orgA]);
  const revenue = await accountId('4100');
  const res = await agent.post(`${STOCK}/items`).send({
    name,
    categoryId: cat[0]?.id,
    attributes: {},
    product: { salePriceCents: 2500, purchasePriceCents: 1000, revenueAccountId: revenue },
  });
  expect(res.status).toBe(201);
  return { stockItemId: res.body.item.id as string, productId: res.body.item.ledgerItemId as string };
}

async function approveBill(productId: string, ref: string): Promise<{ status: number }> {
  const vendor = await agent.post(`${LC}/vendors`).send({ name: `Vendor ${ref}` });
  const bill = await agent.post(`${LC}/bills`).send({
    vendorId: vendor.body.vendor.id,
    vendorReference: ref,
    billDate: '2026-03-01',
    dueDate: '2026-03-31',
    lines: [{ description: 'stock', quantityMilli: 1000, unitPriceCents: 1000, expenseAccountId: await accountId('1140'), itemId: productId }],
  });
  if (bill.status !== 201) return { status: bill.status };
  return agent.post(`${LC}/bills/${bill.body.bill.id}/approve`).send({});
}

async function patchAssetAccount(productId: string, code: string): Promise<{ status: number }> {
  return agent.patch(`${ITEMS}/${productId}`).send({ assetAccountId: await accountId(code) });
}

describe('a product account change races a bill approval', () => {
  it('10 iterations: no request 500s (no deadlock), integrity passes after the loop', async () => {
    await agent.post(`${STOCK}/setup`).send({ industryProfile: 'GENERAL' });
    const created1135 = await agent.post(ACCOUNTS).send({
      code: '1135',
      name: 'Retail Inventory',
      type: 'Asset',
      parentId: await accountId('1100'),
    });
    expect(created1135.status).toBe(201);
    const stocked = await createStockedItem('Racer');

    for (let i = 0; i < 10; i += 1) {
      const targetCode = i % 2 === 0 ? '1135' : '1140';
      const [patchRes, billRes] = await Promise.all([
        patchAssetAccount(stocked.productId, targetCode),
        approveBill(stocked.productId, `RACE-${String(i)}`),
      ]);
      expect(patchRes.status).not.toBe(500);
      expect(billRes.status).not.toBe(500);
    }

    expect((await runIntegrityChecks()).passed).toBe(true);
  });
});
