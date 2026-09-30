import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { runIntegrityChecks } from '../../db/integrity.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * One product form (Xero-style "Track inventory"): creating a tracked product
 * with no inventory setup, opening stock posted with it, and turning tracking
 * on for an existing non-inventory product. Integration tier, real PostgreSQL.
 * Every GL-touching case ends with all integrity checks green. Includes a
 * cross-tenant case (rule 15).
 */

const app = createApp();
const LC = '/api/v1';
const STOCK = '/api/v1/inventory';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let agentA: Agent;
let agentB: Agent;

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'track-a', orgName: 'Track Org A' });
  userB = await createUserWithOrg({ label: 'track-b', orgName: 'Track Org B' });
  orgA = userA.orgId;
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
});

afterAll(closePool);

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id = $1 AND code = $2', [orgId, code]);
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code}`);
  return row.id;
}

async function accountNet(orgId: string, code: string): Promise<number> {
  const { rows } = await pool.query<{ net: string }>(
    `SELECT COALESCE(SUM(l.base_debit_cents - l.base_credit_cents), 0)::text AS net
       FROM ledger_lines l JOIN accounts a ON a.id = l.account_id AND a.org_id = l.org_id
      WHERE l.org_id = $1 AND a.code = $2`,
    [orgId, code],
  );
  return Number(rows[0]?.net ?? '0');
}

async function onHand(orgId: string, stockItemId: string): Promise<{ qty: number; value: number }> {
  const { rows } = await pool.query<{ q: string; v: string }>(
    'SELECT COALESCE(SUM(quantity_milli), 0)::text AS q, COALESCE(SUM(value_cents), 0)::text AS v FROM stock_balances WHERE org_id = $1 AND item_id = $2',
    [orgId, stockItemId],
  );
  return { qty: Number(rows[0]?.q ?? '0'), value: Number(rows[0]?.v ?? '0') };
}

async function settingsRows(orgId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM stock_settings WHERE org_id = $1', [orgId]);
  return Number(rows[0]?.n ?? '0');
}

async function expectIntegrity(): Promise<void> {
  const report = await runIntegrityChecks();
  expect(report.checks.filter((c) => !c.passed)).toEqual([]);
}

/** Cost 60.00, price 100.00 — the trading example from the product brief. */
function trackedProduct(extra: object = {}): object {
  return {
    name: 'Desk lamp',
    product: { salePriceCents: 10_000, purchasePriceCents: 6_000 },
    ...extra,
  };
}

async function invoice(agent: Agent, orgId: string, productId: string, quantity: number): Promise<number> {
  const customer = await agent.post(`${LC}/customers`).send({ name: 'Northwind' });
  const draft = await agent.post(`${LC}/invoices`).send({
    customerId: customer.body.customer.id,
    issueDate: today(),
    dueDate: today(),
    lines: [
      {
        description: 'Desk lamp',
        quantityMilli: quantity * 1000,
        unitPriceCents: 10_000,
        revenueAccountId: await accountId(orgId, '4100'),
        itemId: productId,
      },
    ],
  });
  expect(draft.status).toBe(201);
  const issued = await agent.post(`${LC}/invoices/${draft.body.invoice.id as string}/issue`).send({});
  return issued.status;
}

describe('POST /inventory/items without inventory setup', () => {
  it('sets inventory up silently, creates the product, and posts opening stock at the purchase price', async () => {
    expect(await settingsRows(orgA)).toBe(0);

    const res = await agentA.post(`${STOCK}/items`).send(trackedProduct({ opening: { quantityMilli: 10_000, occurredOn: today() } }));
    expect(res.status).toBe(201);
    expect(res.body.item.tracking).toBe('QUANTITY');
    expect(res.body.item.ledgerItemId).toEqual(expect.any(String));

    expect(await settingsRows(orgA)).toBe(1);
    expect(await onHand(orgA, res.body.item.id as string)).toEqual({ qty: 10_000, value: 60_000 });
    expect(await accountNet(orgA, '1140')).toBe(60_000);
    expect(await accountNet(orgA, '3400')).toBe(-60_000);

    const product = await agentA.get(`${LC}/items/${res.body.item.ledgerItemId as string}`);
    expect(product.body.item).toMatchObject({ itemType: 'INVENTORY', salePriceCents: 10_000, purchasePriceCents: 6_000 });
    await expectIntegrity();
  });

  it('selling 2 of them books COGS at 60.00 each and leaves 8 on hand', async () => {
    const res = await agentA.post(`${STOCK}/items`).send(trackedProduct({ opening: { quantityMilli: 10_000, occurredOn: today() } }));
    expect(await invoice(agentA, orgA, res.body.item.ledgerItemId as string, 2)).toBe(200);

    expect(await onHand(orgA, res.body.item.id as string)).toEqual({ qty: 8_000, value: 48_000 });
    expect(await accountNet(orgA, '5050')).toBe(12_000);
    expect(await accountNet(orgA, '1140')).toBe(48_000);
    await expectIntegrity();
  });

  it('an explicit unit cost overrides the purchase price', async () => {
    const res = await agentA
      .post(`${STOCK}/items`)
      .send(trackedProduct({ opening: { quantityMilli: 5_000, unitCostCents: 5_500, occurredOn: today() } }));
    expect(res.status).toBe(201);
    expect(await onHand(orgA, res.body.item.id as string)).toEqual({ qty: 5_000, value: 27_500 });
  });

  it('no opening stock → the product exists with nothing on hand and no journal', async () => {
    const res = await agentA.post(`${STOCK}/items`).send(trackedProduct());
    expect(res.status).toBe(201);
    expect(await onHand(orgA, res.body.item.id as string)).toEqual({ qty: 0, value: 0 });
    expect(await accountNet(orgA, '1140')).toBe(0);
  });

  it('opening stock with no unit cost and no purchase price → 422, and nothing is left behind', async () => {
    const res = await agentA
      .post(`${STOCK}/items`)
      .send({ name: 'Mystery box', opening: { quantityMilli: 1_000, occurredOn: today() } });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Enter a unit cost for the opening stock, or a purchase price');

    // The whole transaction rolled back — including the silent setup.
    expect(await settingsRows(orgA)).toBe(0);
    const { rows } = await pool.query('SELECT 1 FROM items WHERE org_id = $1', [orgA]);
    expect(rows).toHaveLength(0);
  });

  it('opening stock dated in the future → 422', async () => {
    const res = await agentA.post(`${STOCK}/items`).send(trackedProduct({ opening: { quantityMilli: 1_000, occurredOn: '2999-01-01' } }));
    expect(res.status).toBe(422);
  });

  it('two concurrent first creates → one setup, two products, no error', async () => {
    const [first, second] = await Promise.all([
      agentA.post(`${STOCK}/items`).send(trackedProduct({ name: 'Lamp one' })),
      agentA.post(`${STOCK}/items`).send(trackedProduct({ name: 'Lamp two' })),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await settingsRows(orgA)).toBe(1);
    expect(first.body.item.code).not.toBe(second.body.item.code);
  });

  it('a configured org keeps its own industry profile', async () => {
    await agentA.post(`${STOCK}/setup`).send({ industryProfile: 'RETAIL' });
    const res = await agentA.post(`${STOCK}/items`).send(trackedProduct());
    expect(res.status).toBe(201);
    const { rows } = await pool.query<{ industry_profile: string }>('SELECT industry_profile FROM stock_settings WHERE org_id = $1', [orgA]);
    expect(rows[0]?.industry_profile).toBe('RETAIL');
  });
});

describe('POST /inventory/items/from-product/:productId', () => {
  async function nonInventoryProduct(agent: Agent, orgId: string, code = 'LAMP-01'): Promise<string> {
    const res = await agent.post(`${LC}/items`).send({
      code,
      name: 'Desk lamp',
      itemType: 'NON_INVENTORY',
      salePriceCents: 10_000,
      purchasePriceCents: 6_000,
      expenseAccountId: await accountId(orgId, '6600'),
    });
    expect(res.status).toBe(201);
    return res.body.item.id as string;
  }

  it('turns tracking on: same product, INVENTORY type, linked stock item with the same code, opening stock posted', async () => {
    const productId = await nonInventoryProduct(agentA, orgA);

    const res = await agentA
      .post(`${STOCK}/items/from-product/${productId}`)
      .send({ opening: { quantityMilli: 10_000, occurredOn: today() } });
    expect(res.status).toBe(201);
    expect(res.body.item).toMatchObject({ code: 'LAMP-01', name: 'Desk lamp', ledgerItemId: productId });
    expect(await onHand(orgA, res.body.item.id as string)).toEqual({ qty: 10_000, value: 60_000 });

    const product = await agentA.get(`${LC}/items/${productId}`);
    expect(product.body.item).toMatchObject({ itemType: 'INVENTORY', kind: 'GOODS', expenseAccountId: null });

    expect(await invoice(agentA, orgA, productId, 2)).toBe(200);
    expect(await accountNet(orgA, '5050')).toBe(12_000);
    await expectIntegrity();
  });

  it('is forward-only: a bill posted before the switch stays expensed', async () => {
    const productId = await nonInventoryProduct(agentA, orgA);
    const vendor = await agentA.post(`${LC}/vendors`).send({ name: 'Lamp Co' });
    const bill = await agentA.post(`${LC}/bills`).send({
      vendorId: vendor.body.vendor.id,
      vendorReference: 'B-1',
      billDate: today(),
      dueDate: today(),
      lines: [
        {
          description: 'Desk lamp',
          quantityMilli: 3_000,
          unitPriceCents: 6_000,
          expenseAccountId: await accountId(orgA, '6600'),
          itemId: productId,
        },
      ],
    });
    expect(bill.status).toBe(201);
    expect((await agentA.post(`${LC}/bills/${bill.body.bill.id as string}/approve`).send({})).status).toBe(200);

    const res = await agentA.post(`${STOCK}/items/from-product/${productId}`).send({});
    expect(res.status).toBe(201);

    expect(await accountNet(orgA, '6600')).toBe(18_000);
    expect(await accountNet(orgA, '1140')).toBe(0);
    expect(await onHand(orgA, res.body.item.id as string)).toEqual({ qty: 0, value: 0 });
    await expectIntegrity();
  });

  it('a lower-case product code is upper-cased onto the stock item', async () => {
    const productId = await nonInventoryProduct(agentA, orgA, 'lamp-2');
    const res = await agentA.post(`${STOCK}/items/from-product/${productId}`).send({});
    expect(res.status).toBe(201);
    expect(res.body.item.code).toBe('LAMP-2');
  });

  it('a product code outside the stock grammar falls back to the default code scheme', async () => {
    const productId = await nonInventoryProduct(agentA, orgA, 'Desk lamp #1');
    const res = await agentA.post(`${STOCK}/items/from-product/${productId}`).send({});
    expect(res.status).toBe(201);
    expect(res.body.item.code).toMatch(/^GEN-\d{5}$/);
  });

  it('a service → 422; an already-tracked product → 409', async () => {
    const service = await agentA.post(`${LC}/items`).send({ code: 'CONSULT', name: 'Consulting', itemType: 'SERVICE' });
    const serviceRes = await agentA.post(`${STOCK}/items/from-product/${service.body.item.id as string}`).send({});
    expect(serviceRes.status).toBe(422);
    expect(serviceRes.body.error).toBe('Only a non-inventory product can start tracking inventory');

    const productId = await nonInventoryProduct(agentA, orgA);
    expect((await agentA.post(`${STOCK}/items/from-product/${productId}`).send({})).status).toBe(201);
    const again = await agentA.post(`${STOCK}/items/from-product/${productId}`).send({});
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('This product already tracks inventory');
  });

  it('a failing opening rolls the conversion back — the product stays non-inventory', async () => {
    const productId = await nonInventoryProduct(agentA, orgA);
    const res = await agentA
      .post(`${STOCK}/items/from-product/${productId}`)
      .send({ opening: { quantityMilli: 1_000, occurredOn: today(), locationId: '00000000-0000-4000-8000-000000000000' } });
    expect(res.status).toBe(422);

    const product = await agentA.get(`${LC}/items/${productId}`);
    expect(product.body.item.itemType).toBe('NON_INVENTORY');
    const { rows } = await pool.query('SELECT 1 FROM stock_items WHERE org_id = $1', [orgA]);
    expect(rows).toHaveLength(0);
  });

  it('cross-tenant: org B cannot convert org A’s product (404), and A’s product is untouched', async () => {
    const productId = await nonInventoryProduct(agentA, orgA);
    const res = await agentB.post(`${STOCK}/items/from-product/${productId}`).send({});
    expect(res.status).toBe(404);

    const product = await agentA.get(`${LC}/items/${productId}`);
    expect(product.body.item.itemType).toBe('NON_INVENTORY');
  });
});
