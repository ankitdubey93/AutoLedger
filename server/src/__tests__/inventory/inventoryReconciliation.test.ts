import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { runIntegrityChecks } from '../../db/integrity.js';
import * as stockGlService from '../../services/inventory/stockGlService.js';
import * as ledgerItemService from '../../services/accounting/itemService.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Phase 35a — inventory ties out to the general ledger: reclass machinery,
 * void sweeps, link-writes-the-pair, link-all, and manual movement purposes.
 * Integration tier, real PostgreSQL. Every case ends with `expectIntegrity()`
 * (all 7 checks green). Includes this module's own cross-tenant case (rule 15).
 */

const app = createApp();
const LC = '/api/v1';
const STOCK = '/api/v1/inventory';
const SETTINGS = '/api/v1/settings';
const ACCOUNTS = '/api/v1/accounts';
const ITEMS = '/api/v1/items';
const PERIODS = '/api/v1/fiscal-periods';
const ONBOARDING = '/api/v1/settings/onboarding';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;
let agentA: Agent;

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'reconcile-a', orgName: 'Reconcile Org A' });
  userB = await createUserWithOrg({ label: 'reconcile-b', orgName: 'Reconcile Org B' });
  orgA = userA.orgId;
  orgB = userB.orgId;
  agentA = await loginAgent(app, userA);
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
  code: string;
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
    code: res.body.item.code as string,
  };
}

async function receive(agent: Agent, locationId: string, itemId: string, quantityMilli: number, unitCostCents: number, occurredOn = '2026-03-01', purpose?: 'OPENING' | 'ADJUSTMENT') {
  const res = await agent.post(`${STOCK}/receipts`).send({
    occurredOn,
    locationId,
    lines: [{ itemId, quantityMilli, unitCostCents }],
    ...(purpose === undefined ? {} : { purpose }),
  });
  return res;
}

async function draftBill(agent: Agent, lines: object[], extra: object = {}, ref = 'BILL-1'): Promise<string> {
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
  const billId = await draftBill(agent, [stockBillLine(stocked, quantity, unitPriceCents, { expenseAccountId: await inventoryAccount(orgId) })], {}, ref);
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

async function createAssetAccount(agent: Agent, orgId: string, code: string, name: string): Promise<string> {
  const res = await agent.post(ACCOUNTS).send({ code, name, type: 'Asset', parentId: await accountId(orgId, '1100') });
  expect(res.status).toBe(201);
  return res.body.account.id as string;
}

async function onboard(agent: Agent): Promise<void> {
  const res = await agent.post(ONBOARDING).send({
    organizationName: 'Acme Books',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    booksStartDate: '2026-01-01',
  });
  if (res.status !== 200) throw new Error(`fixture: onboarding failed ${res.status} ${JSON.stringify(res.body)}`);
}

async function closeTodayPeriod(agent: Agent): Promise<void> {
  const now = today();
  const onboardRes = await agent.post(ONBOARDING).send({
    organizationName: 'Acme Books',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    booksStartDate: `${now.slice(0, 4)}-01-01`,
  });
  if (onboardRes.status !== 200) throw new Error(`fixture: onboarding failed ${onboardRes.status}`);

  const generateRes = await agent.post(`${PERIODS}/generate`).send({ containingDate: now });
  const monthPrefix = now.slice(0, 7);
  const period = (generateRes.body.periods as Array<{ id: string; startsOn: string }>).find((p) =>
    p.startsOn.startsWith(monthPrefix),
  );
  if (period === undefined) throw new Error('fixture: no period covering today');
  const closeRes = await agent.post(`${PERIODS}/${period.id}/close`).send({});
  if (closeRes.status !== 200) throw new Error(`fixture: close failed ${closeRes.status} ${JSON.stringify(closeRes.body)}`);
}

/** Unlinks a stocked item the way a pre-Phase-32 record would look: ledger_item_id NULL, no items row. */
async function unlink(stocked: Stocked): Promise<void> {
  await pool.query('ALTER TABLE stock_items DISABLE TRIGGER trg_stock_items_ledger_link_frozen');
  await pool.query('UPDATE stock_items SET ledger_item_id = NULL WHERE id = $1', [stocked.stockItemId]);
  await pool.query('ALTER TABLE stock_items ENABLE TRIGGER trg_stock_items_ledger_link_frozen');
  await pool.query('DELETE FROM items WHERE id = $1', [stocked.productId]);
}

describe('changing a product inventory account reclasses', () => {
  it("changing a product's inventory account moves its stock value", async () => {
    const stocked = await createStockedItem(agentA, orgA);
    const wh2 = await agentA.post(`${STOCK}/locations`).send({ code: 'WH2', name: 'Second', kind: 'WAREHOUSE' });
    await receive(agentA, stocked.locationId, stocked.stockItemId, 10_000, 500);
    await receive(agentA, wh2.body.location.id as string, stocked.stockItemId, 5_000, 500);
    expect(await accountNet(orgA, '1140')).toBe(7500);

    const account1135 = await createAssetAccount(agentA, orgA, '1135', 'Retail Inventory');
    const patched = await agentA.patch(`${ITEMS}/${stocked.productId}`).send({ assetAccountId: account1135 });
    expect(patched.status).toBe(200);

    expect(await accountNet(orgA, '1140')).toBe(0);
    expect(await accountNet(orgA, '1135')).toBe(7500);
    expect(await onHand(orgA, stocked.stockItemId)).toEqual({ qty: 15_000, value: 7500 });
    await expectIntegrity();
  });

  it('changing the settings default moves only defaulted products', async () => {
    await onboard(agentA);
    const p1 = await createStockedItem(agentA, orgA, 'Defaulted');
    await receive(agentA, p1.locationId, p1.stockItemId, 10_000, 300);
    const p2 = await createStockedItem(agentA, orgA, 'Overridden');
    await receive(agentA, p2.locationId, p2.stockItemId, 10_000, 400);
    expect(await accountNet(orgA, '1140')).toBe(3000 + 4000);

    const account1135 = await createAssetAccount(agentA, orgA, '1135', 'Override Inventory');
    const patched = await agentA.patch(`${ITEMS}/${p2.productId}`).send({ assetAccountId: account1135 });
    expect(patched.status).toBe(200);
    expect(await accountNet(orgA, '1140')).toBe(3000);
    expect(await accountNet(orgA, '1135')).toBe(4000);

    const account1136 = await createAssetAccount(agentA, orgA, '1136', 'Default Target');
    const settingsPatched = await agentA.patch(SETTINGS).send({ inventoryAccountId: account1136 });
    expect(settingsPatched.status).toBe(200);

    expect(await accountNet(orgA, '1140')).toBe(0);
    expect(await accountNet(orgA, '1136')).toBe(3000);
    expect(await accountNet(orgA, '1135')).toBe(4000);
    await expectIntegrity();
  });
});

describe('voids sweep stale reclassed value', () => {
  it('voiding a bill after a reclass leaves the old account at zero', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    const billId = await receiveViaBill(agentA, orgA, stocked, 10, 1000, 'B-1');
    const account1135 = await createAssetAccount(agentA, orgA, '1135', 'Retail Inventory');
    await agentA.patch(`${ITEMS}/${stocked.productId}`).send({ assetAccountId: account1135 });
    expect(await accountNet(orgA, '1140')).toBe(0);
    expect(await accountNet(orgA, '1135')).toBe(10_000);

    const res = await agentA.post(`${LC}/bills/${billId}/void`).send({});
    expect(res.status).toBe(200);
    expect(await accountNet(orgA, '1140')).toBe(0);
    expect(await accountNet(orgA, '1135')).toBe(0);
    expect(await onHand(orgA, stocked.stockItemId)).toEqual({ qty: 0, value: 0 });
    await expectIntegrity();
  });

  it('voiding an invoice after a reclass leaves the old account at zero', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    await receiveViaBill(agentA, orgA, stocked, 10, 1000, 'B-1');
    const invoiceId = await draftInvoice(agentA, orgA, stocked, 4);
    const issued = await agentA.post(`${LC}/invoices/${invoiceId}/issue`).send({});
    expect(issued.status).toBe(200);
    expect(await accountNet(orgA, '1140')).toBe(6000);

    const account1135 = await createAssetAccount(agentA, orgA, '1135', 'Retail Inventory');
    await agentA.patch(`${ITEMS}/${stocked.productId}`).send({ assetAccountId: account1135 });
    expect(await accountNet(orgA, '1140')).toBe(0);
    expect(await accountNet(orgA, '1135')).toBe(6000);

    const res = await agentA.post(`${LC}/invoices/${invoiceId}/void`).send({});
    expect(res.status).toBe(200);
    expect(await accountNet(orgA, '1140')).toBe(0);
    expect((await onHand(orgA, stocked.stockItemId)).value).toBe(await accountNet(orgA, '1135'));
    expect(await accountNet(orgA, '1135')).toBe(10_000);
    await expectIntegrity();
  });
});

describe('reclass and a closed period', () => {
  it('a reclass in a closed period is refused and nothing moves', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    await receive(agentA, stocked.locationId, stocked.stockItemId, 10_000, 500);
    const before1140 = await accountNet(orgA, '1140');
    const beforeOnHand = await onHand(orgA, stocked.stockItemId);

    await closeTodayPeriod(agentA);
    const account1135 = await createAssetAccount(agentA, orgA, '1135', 'Retail Inventory');
    const patched = await agentA.patch(`${ITEMS}/${stocked.productId}`).send({ assetAccountId: account1135 });
    expect(patched.status).toBe(422);

    expect(await accountNet(orgA, '1140')).toBe(before1140);
    expect(await accountNet(orgA, '1135')).toBe(0);
    expect(await onHand(orgA, stocked.stockItemId)).toEqual(beforeOnHand);
    const product = await agentA.get(`${ITEMS}/${stocked.productId}`);
    expect(product.body.item.assetAccountId).toBeNull();
    await expectIntegrity();
  });
});

describe('linking writes the RECLASS pair', () => {
  it('linking a pre-existing item writes the RECLASS pair', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    await unlink(stocked);
    await receive(agentA, stocked.locationId, stocked.stockItemId, 2000, 500); // 2 @ 5.00 = 1000
    expect(await accountNet(orgA, '1140')).toBe(0);

    const res = await agentA.post(`${STOCK}/items/${stocked.stockItemId}/link-product`).send({});
    expect(res.status).toBe(200);
    expect(await accountNet(orgA, '1140')).toBe(1000);

    const { rows } = await pool.query<{ movement_type: string; value_cents: string; gl_account_id: string | null; source_id: string | null }>(
      `SELECT movement_type, value_cents, gl_account_id, source_id FROM stock_movements
        WHERE org_id = $1 AND item_id = $2 AND movement_type IN ('RECLASS_OUT', 'RECLASS_IN')
        ORDER BY movement_type`,
      [orgA, stocked.stockItemId],
    );
    expect(rows).toHaveLength(2);
    const out = rows.find((r) => r.movement_type === 'RECLASS_OUT');
    const inRow = rows.find((r) => r.movement_type === 'RECLASS_IN');
    expect(out?.gl_account_id).toBeNull();
    expect(Number(out?.value_cents)).toBe(-1000);
    expect(inRow?.gl_account_id).toBe(await accountId(orgA, '1140'));
    expect(Number(inRow?.value_cents)).toBe(1000);
    expect(inRow?.source_id).toBe(stocked.stockItemId);
    await expectIntegrity();
  });

  it('the 076 backfill repairs a link made before 35a, idempotently', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    await unlink(stocked);
    await receive(agentA, stocked.locationId, stocked.stockItemId, 2000, 500); // value 1000, gl_account_id NULL
    expect(await accountNet(orgA, '1140')).toBe(0);

    const inventoryAccountId = await accountId(orgA, '1140');
    await withTransaction(async (client) => {
      const linked = await ledgerItemService.createLinkedItemOnClient(client, orgA, userA.id, {
        code: stocked.code,
        name: 'Widget',
        itemType: 'INVENTORY',
        salePriceCents: null,
        purchasePriceCents: null,
        revenueAccountId: null,
        assetAccountId: null,
        cogsAccountId: null,
        saleTaxRateBp: 0,
        purchaseTaxRateBp: 0,
      });
      await client.query('UPDATE stock_items SET ledger_item_id = $2 WHERE id = $1 AND org_id = $3', [
        stocked.stockItemId,
        linked.id,
        orgA,
      ]);
      await stockGlService.postLinkOpeningOnClient(
        client,
        orgA,
        userA.id,
        stocked.stockItemId,
        inventoryAccountId,
        1000,
        '2026-03-01',
        stocked.code,
      );
    });

    // No RECLASS pair exists yet — the pre-35a gap the migration repairs.
    expect(await accountNet(orgA, '1140')).toBe(1000);
    let report = await runIntegrityChecks();
    expect(report.checks.find((c) => c.name === 'inventory_accounts_reconcile_with_gl')?.passed).toBe(false);

    const migrationSql = readFileSync('src/db/migrations/076_stock_gl_reconciliation.sql', 'utf8');
    await pool.query(migrationSql);
    await pool.query(migrationSql);

    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stock_movements
        WHERE org_id = $1 AND item_id = $2 AND movement_type = 'RECLASS_IN' AND source_type = 'stock' AND source_id = $2`,
      [orgA, stocked.stockItemId],
    );
    expect(rows[0]?.n).toBe('1');

    report = await runIntegrityChecks();
    expect(report.checks.find((c) => c.name === 'inventory_accounts_reconcile_with_gl')?.passed).toBe(true);
  });
});

describe('link-all', () => {
  it('link-all links every unlinked item and reports code collisions', async () => {
    const a = await createStockedItem(agentA, orgA, 'Item A');
    await unlink(a);
    const b = await createStockedItem(agentA, orgA, 'Item B');
    await unlink(b);

    // A collision: a SERVICE product already using b's code.
    const collide = await agentA.post(ITEMS).send({ code: b.code, name: 'Existing service', itemType: 'SERVICE' });
    expect(collide.status).toBe(201);

    const res = await agentA.post(`${STOCK}/items/link-all`).send({});
    expect(res.status).toBe(200);
    expect(res.body.result.linkedCount).toBe(1);
    expect(res.body.result.failures).toHaveLength(1);
    expect(res.body.result.failures[0].stockItemId).toBe(b.stockItemId);
    expect(res.body.result.failures[0].message).toContain('already exists');
    await expectIntegrity();
  });
});

describe('manual movement purpose and consumption', () => {
  it('a manual receipt with purpose ADJUSTMENT credits 5400, not 3400', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    const res = await receive(agentA, stocked.locationId, stocked.stockItemId, 4000, 250, '2026-03-01', 'ADJUSTMENT');
    expect(res.status).toBe(201);
    expect(await accountNet(orgA, '1140')).toBe(1000);
    expect(await accountNet(orgA, '5400')).toBe(-1000);
    expect(await accountNet(orgA, '3400')).toBe(0);
    await expectIntegrity();
  });

  it('a manual issue with an expense account posts consumption to it', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    await receive(agentA, stocked.locationId, stocked.stockItemId, 10_000, 100);
    const expenseAccount = await accountId(orgA, '6100');

    const res = await agentA.post(`${STOCK}/issues`).send({
      occurredOn: '2026-03-02',
      locationId: stocked.locationId,
      lines: [{ itemId: stocked.stockItemId, quantityMilli: 3000, lotId: null, serialIds: null }],
      expenseAccountId: expenseAccount,
    });
    expect(res.status).toBe(201);
    expect(await accountNet(orgA, '6100')).toBe(300);
    expect(await accountNet(orgA, '1140')).toBe(700);
    expect(await accountNet(orgA, '5400')).toBe(0);
    await expectIntegrity();
  });

  it('a manual issue to a non-expense account is refused', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    await receive(agentA, stocked.locationId, stocked.stockItemId, 10_000, 100);
    const nonExpenseAccount = await accountId(orgA, '1130');

    const res = await agentA.post(`${STOCK}/issues`).send({
      occurredOn: '2026-03-02',
      locationId: stocked.locationId,
      lines: [{ itemId: stocked.stockItemId, quantityMilli: 3000, lotId: null, serialIds: null }],
      expenseAccountId: nonExpenseAccount,
    });
    expect(res.status).toBe(422);
    expect(await onHand(orgA, stocked.stockItemId)).toEqual({ qty: 10_000, value: 1000 });
    await expectIntegrity();
  });
});

describe('cross-tenant isolation (rule 15)', () => {
  it('org B cannot reclass, true-up, link-all or read valuation of org A', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    await receive(agentA, stocked.locationId, stocked.stockItemId, 10_000, 500);
    const aInventoryAccountId = await accountId(orgA, '1140');

    const agentB = await loginAgent(app, userB);
    const bInventoryAccountId = await accountId(orgB, '1140');

    const valuation = await agentB.get(`${STOCK}/valuation`);
    expect(valuation.status).toBe(200);
    const accountIds = (valuation.body.valuation.accounts as { accountId: string }[]).map((a) => a.accountId);
    expect(accountIds).not.toContain(aInventoryAccountId);

    const trueUp = await agentB
      .post(`${STOCK}/reconcile/true-up`)
      .send({ accountId: aInventoryAccountId, expectedDifferenceCents: 5000 });
    expect(trueUp.status).toBe(422);
    expect(trueUp.body.error).toBe('That account is not an inventory account');

    // Org B's own account, with no drift, is refused for a different reason (already ties).
    const trueUpOwn = await agentB
      .post(`${STOCK}/reconcile/true-up`)
      .send({ accountId: bInventoryAccountId, expectedDifferenceCents: 5000 });
    expect(trueUpOwn.status).not.toBe(200);

    const reclass = await agentB.post(`${STOCK}/reconcile/reclass`).send({});
    expect(reclass.status).toBe(200);
    expect(reclass.body.postingCount).toBe(0);

    const linkAll = await agentB.post(`${STOCK}/items/link-all`).send({});
    expect(linkAll.status).toBe(200);
    expect(linkAll.body.result.linkedCount).toBe(0);
  });
});
