import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { runIntegrityChecks } from '../../db/integrity.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Phase 32 — a LedgerCore bill receives stock and a LedgerCore invoice issues
 * it, posting to the GL through StockLedger's document seam. Integration tier,
 * real PostgreSQL. The integrity checker (which now includes the stock <-> GL
 * reconciliation) must pass after every scenario. Includes this seam's own
 * cross-tenant case (rule 15).
 */

const app = createApp();
const LC = '/api/v1/ledger-core';
const STOCK = '/api/v1/stock';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;
let agentA: Agent;

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userB.orgId;
  agentA = await loginAgent(app, userA);
});

afterAll(closePool);

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id = $1 AND code = $2', [orgId, code]);
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code}`);
  return row.id;
}

/** Net debit (debit - credit) on an account across every ledger line of the org, in base cents. */
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

async function expectIntegrity(): Promise<void> {
  const report = await runIntegrityChecks();
  expect(report.checks.filter((c) => !c.passed)).toEqual([]);
  expect(report.passed).toBe(true);
}

interface Stocked {
  stockItemId: string;
  productId: string;
  locationId: string;
}

/** Applies the GENERAL stock profile and creates one QUANTITY item (EA) — which also creates its linked product. */
async function createStockedItem(agent: Agent, orgId: string, name = 'Widget'): Promise<Stocked> {
  await agent.post(`${STOCK}/setup`).send({ industryProfile: 'GENERAL' });
  const { rows: cat } = await pool.query<{ id: string }>("SELECT id FROM stock_categories WHERE org_id = $1 AND code = 'GEN'", [orgId]);
  const { rows: loc } = await pool.query<{ id: string }>("SELECT id FROM stock_locations WHERE org_id = $1 AND code = 'MAIN'", [orgId]);
  const revenue = await accountId(orgId, '4100');
  const res = await agent.post(`${STOCK}/items`).send({
    name,
    categoryId: cat[0]?.id,
    attributes: {},
    product: { salePriceCents: 2500, purchasePriceCents: 1000, revenueAccountId: revenue },
  });
  expect(res.status).toBe(201);
  return {
    stockItemId: res.body.item.id as string,
    productId: res.body.item.ledgerItemId as string,
    locationId: loc[0]?.id as string,
  };
}

async function draftBill(agent: Agent, _orgId: string, lines: object[], extra: object = {}, ref = 'BILL-1'): Promise<string> {
  const vendor = await agent.post(`${LC}/vendors`).send({ name: `Vendor ${ref}` });
  const res = await agent.post(`${LC}/bills`).send({
    vendorId: vendor.body.vendor.id,
    vendorReference: ref,
    billDate: '2026-03-01',
    dueDate: '2026-03-31',
    lines,
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.bill.id as string;
}

function stockBillLine(stocked: Stocked, quantity: number, unitPriceCents: number, extra: object = {}): object {
  return {
    description: 'Widget',
    quantityMilli: quantity * 1000,
    unitPriceCents,
    expenseAccountId: undefined,
    itemId: stocked.productId,
    ...extra,
  };
}

async function inventoryAccount(orgId: string): Promise<string> {
  return accountId(orgId, '1140');
}

async function receiveViaBill(agent: Agent, orgId: string, stocked: Stocked, quantity: number, unitPriceCents: number, ref: string): Promise<string> {
  const billId = await draftBill(agent, orgId, [stockBillLine(stocked, quantity, unitPriceCents, { expenseAccountId: await inventoryAccount(orgId) })], {}, ref);
  const res = await agent.post(`${LC}/bills/${billId}/approve`).send({});
  expect(res.status).toBe(200);
  return billId;
}

async function draftInvoice(agent: Agent, orgId: string, stocked: Stocked, quantity: number, unitPriceCents = 2500): Promise<string> {
  const customer = await agent.post(`${LC}/customers`).send({ name: 'Northwind' });
  const res = await agent.post(`${LC}/invoices`).send({
    customerId: customer.body.customer.id,
    issueDate: '2026-03-05',
    dueDate: '2026-04-04',
    lines: [
      {
        description: 'Widget',
        quantityMilli: quantity * 1000,
        unitPriceCents,
        revenueAccountId: await accountId(orgId, '4100'),
        itemId: stocked.productId,
      },
    ],
  });
  expect(res.status).toBe(201);
  return res.body.invoice.id as string;
}

describe('a StockLedger item is a LedgerCore product', () => {
  it('creating a stock item creates a linked INVENTORY product in Products & Services', async () => {
    const stocked = await createStockedItem(agentA, orgA);

    const res = await agentA.get(`${LC}/items/${stocked.productId}`);
    expect(res.status).toBe(200);
    expect(res.body.item.itemType).toBe('INVENTORY');
    expect(res.body.item.kind).toBe('GOODS');
    expect(res.body.item.stockManaged).toBe(true);
    expect(res.body.item.salePriceCents).toBe(2500);
  });

  it('LedgerCore refuses to create an INVENTORY item directly', async () => {
    const res = await agentA.post(`${LC}/items`).send({ code: 'NOPE', name: 'Nope', itemType: 'INVENTORY' });
    expect(res.status).toBe(422);
  });
});

describe('bill approval receives stock', () => {
  it('debits Inventory instead of expense and adds the quantity at the net value', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    await receiveViaBill(agentA, orgA, stocked, 10, 1000, 'B-1');

    expect(await onHand(orgA, stocked.stockItemId)).toEqual({ qty: 10_000, value: 10_000 });
    expect(await accountNet(orgA, '1140')).toBe(10_000);
    await expectIntegrity();
  });

  it('stamps the item inventory account on the line even if the client sent an expense account', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    const billId = await draftBill(agentA, orgA, [stockBillLine(stocked, 2, 500, { expenseAccountId: await accountId(orgA, '6100') })]);
    const bill = await agentA.get(`${LC}/bills/${billId}`);
    expect(bill.body.bill.lines[0].expenseAccountCode).toBe('1140');
  });

  it('refuses a non-stock line that posts to the inventory account', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    const inventory = await inventoryAccount(orgA);
    const billId = await draftBill(agentA, orgA, [
      stockBillLine(stocked, 1, 1000, { expenseAccountId: inventory }),
      { description: 'Loose part', quantityMilli: 1000, unitPriceCents: 300, expenseAccountId: inventory, itemId: null },
    ]);
    const res = await agentA.post(`${LC}/bills/${billId}/approve`).send({});
    expect(res.status).toBe(422);
    expect(await onHand(orgA, stocked.stockItemId)).toEqual({ qty: 0, value: 0 });
    await expectIntegrity();
  });

  it('splits a multi-line inventory group across receipts so they add up to the GL debit', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    const inventory = await inventoryAccount(orgA);
    const billId = await draftBill(agentA, orgA, [
      stockBillLine(stocked, 3, 333, { expenseAccountId: inventory }),
      stockBillLine(stocked, 3, 333, { expenseAccountId: inventory }),
    ]);
    const res = await agentA.post(`${LC}/bills/${billId}/approve`).send({});
    expect(res.status).toBe(200);
    expect((await onHand(orgA, stocked.stockItemId)).value).toBe(1998);
    expect(await accountNet(orgA, '1140')).toBe(1998);
    await expectIntegrity();
  });

  it('receives a foreign-currency bill at its BASE-currency value', async () => {
    const patched = await agentA.patch('/api/v1/organizations').send({ baseCurrency: 'INR' });
    expect(patched.status).toBe(200);
    await agentA.post(`${LC}/fx-rates`).send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-01-01', rate: '83.00000000' });
    const stocked = await createStockedItem(agentA, orgA);

    const inventory = await inventoryAccount(orgA);
    const billId = await draftBill(agentA, orgA, [stockBillLine(stocked, 10, 1000, { expenseAccountId: inventory })], { currencyCode: 'USD' });
    const res = await agentA.post(`${LC}/bills/${billId}/approve`).send({});
    expect(res.status).toBe(200);

    // 10 x $10.00 = $100.00 = 10000 USD cents; base (INR) = 10000 x 83 = 830000
    expect((await onHand(orgA, stocked.stockItemId)).value).toBe(830_000);
    expect(await accountNet(orgA, '1140')).toBe(830_000);
    await expectIntegrity();
  });

  it('refuses a lot-tracked item on a bill line', async () => {
    await agentA.post(`${STOCK}/setup`).send({ industryProfile: 'GENERAL' });
    const { rows: cat } = await pool.query<{ id: string }>("SELECT id FROM stock_categories WHERE org_id = $1 AND code = 'GEN'", [orgA]);
    const lotItem = await agentA.post(`${STOCK}/items`).send({ name: 'Lot thing', categoryId: cat[0]?.id, attributes: {}, tracking: 'LOT' });
    expect(lotItem.status).toBe(201);

    const vendor = await agentA.post(`${LC}/vendors`).send({ name: 'V' });
    const res = await agentA.post(`${LC}/bills`).send({
      vendorId: vendor.body.vendor.id,
      vendorReference: 'LOT-1',
      billDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [{ description: 'Lot thing', quantityMilli: 1000, unitPriceCents: 100, expenseAccountId: await inventoryAccount(orgA), itemId: lotItem.body.item.ledgerItemId }],
    });
    expect(res.status).toBe(422);
    expect(res.body.message ?? res.body.error).toMatch(/lot/i);
  });
});

describe('invoice issue issues stock and posts cost of sales', () => {
  it('issues at moving average and adds Dr COGS / Cr Inventory to the same entry', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    await receiveViaBill(agentA, orgA, stocked, 10, 1000, 'B-1');

    const invoiceId = await draftInvoice(agentA, orgA, stocked, 4);
    const res = await agentA.post(`${LC}/invoices/${invoiceId}/issue`).send({});
    expect(res.status).toBe(200);

    expect(await onHand(orgA, stocked.stockItemId)).toEqual({ qty: 6000, value: 6000 });
    expect(await accountNet(orgA, '5050')).toBe(4000);
    expect(await accountNet(orgA, '1140')).toBe(6000);

    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ledger_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
        WHERE e.org_id = $1 AND e.source_type = 'invoice' AND e.source_id = $2`,
      [orgA, invoiceId],
    );
    // receivable + revenue + COGS + inventory in ONE entry
    expect(Number(rows[0]?.n)).toBe(4);
    await expectIntegrity();
  });

  it('a 409 for short stock leaves the invoice a DRAFT with no number consumed', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    await receiveViaBill(agentA, orgA, stocked, 2, 1000, 'B-1');

    const invoiceId = await draftInvoice(agentA, orgA, stocked, 5);
    const res = await agentA.post(`${LC}/invoices/${invoiceId}/issue`).send({});
    expect(res.status).toBe(409);

    const invoice = await agentA.get(`${LC}/invoices/${invoiceId}`);
    expect(invoice.body.invoice.status).toBe('DRAFT');
    expect(invoice.body.invoice.invoiceNumber).toBeNull();
    expect(await onHand(orgA, stocked.stockItemId)).toEqual({ qty: 2000, value: 2000 });
    await expectIntegrity();
  });

  it('voiding the invoice returns stock at the exact issued value and reverses COGS', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    await receiveViaBill(agentA, orgA, stocked, 3, 333, 'B-1'); // value 999, avg 333

    const invoiceId = await draftInvoice(agentA, orgA, stocked, 2);
    await agentA.post(`${LC}/invoices/${invoiceId}/issue`).send({});
    expect((await onHand(orgA, stocked.stockItemId)).value).toBe(333);

    const res = await agentA.post(`${LC}/invoices/${invoiceId}/void`).send({});
    expect(res.status).toBe(200);
    expect(await onHand(orgA, stocked.stockItemId)).toEqual({ qty: 3000, value: 999 });
    expect(await accountNet(orgA, '5050')).toBe(0);
    expect(await accountNet(orgA, '1140')).toBe(999);
    await expectIntegrity();
  });
});

describe('bill void', () => {
  it('removes the received stock and reverses the inventory debit', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    const billId = await receiveViaBill(agentA, orgA, stocked, 5, 1000, 'B-1');

    const res = await agentA.post(`${LC}/bills/${billId}/void`).send({});
    expect(res.status).toBe(200);
    expect(await onHand(orgA, stocked.stockItemId)).toEqual({ qty: 0, value: 0 });
    expect(await accountNet(orgA, '1140')).toBe(0);
    await expectIntegrity();
  });

  it('is refused (409) once the received stock has been sold', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    const billId = await receiveViaBill(agentA, orgA, stocked, 5, 1000, 'B-1');
    const invoiceId = await draftInvoice(agentA, orgA, stocked, 3);
    await agentA.post(`${LC}/invoices/${invoiceId}/issue`).send({});

    const res = await agentA.post(`${LC}/bills/${billId}/void`).send({});
    expect(res.status).toBe(409);
    expect((await agentA.get(`${LC}/bills/${billId}`)).body.bill.status).toBe('POSTED');
    await expectIntegrity();
  });

  it('removes the ORIGINAL value when nothing has changed after a later, dearer receipt', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    await receiveViaBill(agentA, orgA, stocked, 10, 500, 'B-1'); // 10 @ 5.00 = 5000
    const second = await receiveViaBill(agentA, orgA, stocked, 10, 1000, 'B-2'); // 10 @ 10.00 = 10000

    await agentA.post(`${LC}/bills/${second}/void`).send({});
    // Moving average would leave 7500; removing the original value leaves the correct 5000.
    expect(await onHand(orgA, stocked.stockItemId)).toEqual({ qty: 10_000, value: 5000 });
    expect(await accountNet(orgA, '1140')).toBe(5000);
    await expectIntegrity();
  });

  it('posts a variance entry when the balance no longer holds the original value', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    await receiveViaBill(agentA, orgA, stocked, 10, 1000, 'B-1'); // 10 @ 10.00 = 10000
    const second = await receiveViaBill(agentA, orgA, stocked, 10, 2000, 'B-2'); // +20000 => 20 / 30000
    const invoiceId = await draftInvoice(agentA, orgA, stocked, 10);
    await agentA.post(`${LC}/invoices/${invoiceId}/issue`).send({}); // 10 out at avg 15.00 = 15000 => 10 / 15000

    // Void the second bill: 10 units remain (>= 10 received), original value 20000 > 15000 held => clamp to 15000.
    const res = await agentA.post(`${LC}/bills/${second}/void`).send({});
    expect(res.status).toBe(200);
    expect(await onHand(orgA, stocked.stockItemId)).toEqual({ qty: 0, value: 0 });
    // GL follows the stock ledger: inventory is exactly zero, the 5000 clamp sits in adjustments.
    expect(await accountNet(orgA, '1140')).toBe(0);
    expect(await accountNet(orgA, '5400')).toBe(-5000);
    await expectIntegrity();
  });
});

describe('manual StockLedger movements of a linked item post to the GL', () => {
  it('a manual receipt debits Inventory against opening-stock equity', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    const res = await agentA.post(`${STOCK}/receipts`).send({
      occurredOn: '2026-03-01',
      locationId: stocked.locationId,
      lines: [{ itemId: stocked.stockItemId, quantityMilli: 4000, unitCostCents: 250 }],
    });
    expect(res.status).toBe(201);
    expect(await accountNet(orgA, '1140')).toBe(1000);
    expect(await accountNet(orgA, '3400')).toBe(-1000);
    await expectIntegrity();
  });

  it('a manual adjustment out debits Inventory Adjustments', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    await agentA.post(`${STOCK}/receipts`).send({
      occurredOn: '2026-03-01',
      locationId: stocked.locationId,
      lines: [{ itemId: stocked.stockItemId, quantityMilli: 4000, unitCostCents: 250 }],
    });
    const res = await agentA.post(`${STOCK}/adjustments`).send({
      occurredOn: '2026-03-02',
      reason: 'Damaged',
      locationId: stocked.locationId,
      lines: [{ itemId: stocked.stockItemId, direction: 'OUT', quantityMilli: 2000 }],
    });
    expect(res.status).toBe(201);
    expect(await accountNet(orgA, '5400')).toBe(500);
    expect(await accountNet(orgA, '1140')).toBe(500);
    await expectIntegrity();
  });

  it('a transfer posts nothing', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    await agentA.post(`${STOCK}/receipts`).send({
      occurredOn: '2026-03-01',
      locationId: stocked.locationId,
      lines: [{ itemId: stocked.stockItemId, quantityMilli: 4000, unitCostCents: 250 }],
    });
    const wh2 = await agentA.post(`${STOCK}/locations`).send({ code: 'WH2', name: 'Second', kind: 'WAREHOUSE' });
    const before = await accountNet(orgA, '1140');
    const res = await agentA.post(`${STOCK}/transfers`).send({
      occurredOn: '2026-03-02',
      fromLocationId: stocked.locationId,
      toLocationId: wh2.body.location.id,
      lines: [{ itemId: stocked.stockItemId, quantityMilli: 1000 }],
    });
    expect(res.status).toBe(201);
    expect(await accountNet(orgA, '1140')).toBe(before);
  });

  it('a movement dated in a closed period is refused and the stock does not move', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    const onboarded = await agentA.post(`${LC}/settings/onboarding`).send({
      organizationName: 'Acme Books',
      baseCurrency: 'USD',
      fiscalYearStartMonth: 1,
      booksStartDate: '2026-01-01',
    });
    expect(onboarded.status).toBe(200);
    const generated = await agentA.post(`${LC}/fiscal-periods/generate`).send({ containingDate: '2026-06-15' });
    const january = (generated.body.periods as { id: string; startsOn: string }[]).find((p) => p.startsOn.startsWith('2026-01'));
    await agentA.post(`${LC}/fiscal-periods/${january?.id}/close`);

    const res = await agentA.post(`${STOCK}/receipts`).send({
      occurredOn: '2026-01-10',
      locationId: stocked.locationId,
      lines: [{ itemId: stocked.stockItemId, quantityMilli: 1000, unitCostCents: 100 }],
    });
    expect(res.status).toBe(422);
    // The journal refusal rolled the stock movement back with it (rule 5).
    expect(await onHand(orgA, stocked.stockItemId)).toEqual({ qty: 0, value: 0 });
    await expectIntegrity();
  });
});

describe('linking a pre-existing stock item', () => {
  it('posts an opening entry for the stock it already holds', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    // Simulate a pre-Phase-32 item: unlink it and give it stock with no GL effect.
    await pool.query('ALTER TABLE stock_items DISABLE TRIGGER trg_stock_items_ledger_link_frozen');
    await pool.query('UPDATE stock_items SET ledger_item_id = NULL WHERE id = $1', [stocked.stockItemId]);
    await pool.query('ALTER TABLE stock_items ENABLE TRIGGER trg_stock_items_ledger_link_frozen');
    await pool.query('DELETE FROM items WHERE id = $1', [stocked.productId]);
    await agentA.post(`${STOCK}/receipts`).send({
      occurredOn: '2026-03-01',
      locationId: stocked.locationId,
      lines: [{ itemId: stocked.stockItemId, quantityMilli: 2000, unitCostCents: 500 }],
    });
    expect(await accountNet(orgA, '1140')).toBe(0);

    const res = await agentA.post(`${STOCK}/items/${stocked.stockItemId}/link-product`).send({});
    expect(res.status).toBe(200);
    expect(res.body.item.ledgerItemId).not.toBeNull();
    expect(await accountNet(orgA, '1140')).toBe(1000);
    expect(await accountNet(orgA, '3400')).toBe(-1000);

    const again = await agentA.post(`${STOCK}/items/${stocked.stockItemId}/link-product`).send({});
    expect(again.status).toBe(409);
    await expectIntegrity();
  });

  it('renaming or deactivating in StockLedger syncs the linked product', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    await agentA.patch(`${STOCK}/items/${stocked.stockItemId}`).send({ name: 'Widget Pro', isActive: false });
    const product = await agentA.get(`${LC}/items/${stocked.productId}`);
    expect(product.body.item.name).toBe('Widget Pro');
    expect(product.body.item.isActive).toBe(false);
  });

  it('LedgerCore refuses to rename a stock-managed product', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    const res = await agentA.patch(`${LC}/items/${stocked.productId}`).send({ name: 'Hijack' });
    expect(res.status).toBe(422);
  });
});

describe('cross-tenant isolation (rule 15)', () => {
  it("org B cannot use org A's product on its own bill", async () => {
    const stocked = await createStockedItem(agentA, orgA);
    const agentB = await loginAgent(app, userB);
    const vendor = await agentB.post(`${LC}/vendors`).send({ name: 'V' });
    const res = await agentB.post(`${LC}/bills`).send({
      vendorId: vendor.body.vendor.id,
      vendorReference: 'X-1',
      billDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [{ description: 'x', quantityMilli: 1000, unitPriceCents: 100, expenseAccountId: await accountId(orgB, '6100'), itemId: stocked.productId }],
    });
    expect(res.status).toBe(422);
    expect(await onHand(orgA, stocked.stockItemId)).toEqual({ qty: 0, value: 0 });
  });

  it("org B cannot link or read org A's stock item or product", async () => {
    const stocked = await createStockedItem(agentA, orgA);
    const agentB = await loginAgent(app, userB);
    expect((await agentB.post(`${STOCK}/items/${stocked.stockItemId}/link-product`).send({})).status).toBe(404);
    expect((await agentB.get(`${LC}/items/${stocked.productId}`)).status).toBe(404);
    const balances = await agentB.get(`${STOCK}/product-balances`);
    expect(balances.status).toBe(200);
    expect(balances.body.balances).toEqual([]);
  });

  it("org B cannot use org A's account as a product inventory account", async () => {
    await createStockedItem(agentA, orgA);
    const agentB = await loginAgent(app, userB);
    await agentB.post(`${STOCK}/setup`).send({ industryProfile: 'GENERAL' });
    const { rows: cat } = await pool.query<{ id: string }>("SELECT id FROM stock_categories WHERE org_id = $1 AND code = 'GEN'", [orgB]);
    const res = await agentB.post(`${STOCK}/items`).send({
      name: 'Sneaky',
      categoryId: cat[0]?.id,
      attributes: {},
      product: { assetAccountId: await accountId(orgA, '1140') },
    });
    expect(res.status).toBe(422);
    const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM stock_items WHERE org_id = $1', [orgB]);
    expect(Number(rows[0]?.n)).toBe(0);
  });
});
