import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { runIntegrityChecks } from '../../db/integrity.js';
import * as journalService from '../../services/accounting/journalService.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Phase 35a — GET /inventory/valuation, POST /reconcile/true-up and
 * /reconcile/reclass, and the summary split. Integration tier, real
 * PostgreSQL.
 */

const app = createApp();
const LC = '/api/v1';
const STOCK = '/api/v1/inventory';
const ACCOUNTS = '/api/v1/accounts';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let orgA: string;
let agentA: Agent;

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'valuation-a', orgName: 'Valuation Org A' });
  orgA = userA.orgId;
  agentA = await loginAgent(app, userA);
});

afterAll(closePool);

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id = $1 AND code = $2', [orgId, code]);
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code}`);
  return row.id;
}

interface Stocked {
  stockItemId: string;
  productId: string;
  locationId: string;
}

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

async function draftBillDated(
  agent: Agent,
  orgId: string,
  stocked: Stocked,
  quantity: number,
  unitPriceCents: number,
  billDate: string,
  ref: string,
): Promise<string> {
  const vendor = await agent.post(`${LC}/vendors`).send({ name: `Vendor ${ref}` });
  const res = await agent.post(`${LC}/bills`).send({
    vendorId: vendor.body.vendor.id,
    vendorReference: ref,
    billDate,
    dueDate: '2026-12-31',
    lines: [
      {
        description: 'Widget',
        quantityMilli: quantity * 1000,
        unitPriceCents,
        expenseAccountId: await accountId(orgId, '1140'),
        itemId: stocked.productId,
      },
    ],
  });
  expect(res.status).toBe(201);
  return res.body.bill.id as string;
}

async function receiveViaBill(agent: Agent, orgId: string, stocked: Stocked, quantity: number, unitPriceCents: number, billDate: string, ref: string): Promise<string> {
  const billId = await draftBillDated(agent, orgId, stocked, quantity, unitPriceCents, billDate, ref);
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

interface ValuationAccountRow {
  accountId: string;
  code: string;
  subledgerCents: number;
  glCents: number;
  differenceCents: number;
  unexplainedLines: { sourceType: string }[];
}

async function getValuation(agent: Agent, asOf?: string): Promise<{ accounts: ValuationAccountRow[]; tiesOut: boolean; misplaced: unknown[] }> {
  const res = await agent.get(`${STOCK}/valuation${asOf === undefined ? '' : `?asOf=${asOf}`}`);
  expect(res.status).toBe(200);
  return res.body.valuation as { accounts: ValuationAccountRow[]; tiesOut: boolean; misplaced: unknown[] };
}

async function postLegacyManualJournal(orgId: string, userId: string, amountCents: number, entryDate = '2026-03-01'): Promise<string> {
  return withTransaction(async (client) =>
    journalService.createEntryOnClient(client, orgId, userId, {
      entryDate,
      description: 'legacy manual journal directly on 1140',
      lines: [
        { accountId: await accountId(orgId, '1140'), debitCents: amountCents, creditCents: 0 },
        { accountId: await accountId(orgId, '4100'), debitCents: 0, creditCents: amountCents },
      ],
    }),
  );
}

async function inventoryDifference(agent: Agent): Promise<ValuationAccountRow> {
  const valuation = await getValuation(agent);
  const row = valuation.accounts.find((a) => a.code === '1140');
  if (row === undefined) throw new Error('fixture: no 1140 row in valuation');
  return row;
}

async function checkSeven(): Promise<boolean> {
  const report = await runIntegrityChecks();
  return report.checks.find((c) => c.name === 'inventory_accounts_reconcile_with_gl')?.passed ?? false;
}

describe('GET /inventory/valuation', () => {
  it('a clean org ties out', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    await receiveViaBill(agentA, orgA, stocked, 10, 1000, '2026-03-01', 'B-1');
    const invoiceId = await draftInvoice(agentA, orgA, stocked, 4);
    expect((await agentA.post(`${LC}/invoices/${invoiceId}/issue`).send({})).status).toBe(200);

    const valuation = await getValuation(agentA);
    expect(valuation.tiesOut).toBe(true);
    const row = valuation.accounts.find((a) => a.code === '1140');
    expect(row?.differenceCents).toBe(0);
  });

  it('a legacy manual journal shows as an unexplained difference', async () => {
    await createStockedItem(agentA, orgA);
    await postLegacyManualJournal(orgA, userA.id, 5000);

    const row = await inventoryDifference(agentA);
    expect(row.differenceCents).toBe(5000);
    expect(row.unexplainedLines[0]?.sourceType).toBe('manual');
    expect(await checkSeven()).toBe(false);
  });
});

describe('POST /inventory/reconcile/true-up', () => {
  it('true-up closes the difference', async () => {
    await createStockedItem(agentA, orgA);
    await postLegacyManualJournal(orgA, userA.id, 5000);
    const before = await inventoryDifference(agentA);
    expect(before.differenceCents).toBe(5000);

    const trueUp = await agentA
      .post(`${STOCK}/reconcile/true-up`)
      .send({ accountId: before.accountId, expectedDifferenceCents: before.differenceCents });
    expect(trueUp.status).toBe(201);

    const after = await getValuation(agentA);
    expect(after.tiesOut).toBe(true);
    expect(await checkSeven()).toBe(true);

    const { rows } = await pool.query<{ difference_cents: string }>(
      'SELECT difference_cents FROM stock_gl_true_ups WHERE org_id = $1 AND account_id = $2',
      [orgA, before.accountId],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.difference_cents)).toBe(5000);
  });

  it('a stale expected difference is refused', async () => {
    await createStockedItem(agentA, orgA);
    await postLegacyManualJournal(orgA, userA.id, 5000);
    const before = await inventoryDifference(agentA);

    const res = await agentA
      .post(`${STOCK}/reconcile/true-up`)
      .send({ accountId: before.accountId, expectedDifferenceCents: before.differenceCents + 100 });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('The difference has changed');
  });

  it('a tied account is refused', async () => {
    await createStockedItem(agentA, orgA);
    const account1140 = await accountId(orgA, '1140');

    const res = await agentA.post(`${STOCK}/reconcile/true-up`).send({ accountId: account1140, expectedDifferenceCents: 100 });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already ties');
  });
});

describe('POST /inventory/reconcile/reclass', () => {
  it('misplaced value is listed and moved', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    await receiveViaBill(agentA, orgA, stocked, 10, 1000, '2026-03-01', 'B-1');
    const account1135 = await agentA.post(ACCOUNTS).send({
      code: '1135',
      name: 'Retail Inventory',
      type: 'Asset',
      parentId: await accountId(orgA, '1100'),
    });
    expect(account1135.status).toBe(201);
    // Simulates a pre-35a direct product edit that bypassed the reclass machinery.
    await pool.query('UPDATE items SET asset_account_id = $1 WHERE id = $2 AND org_id = $3', [
      account1135.body.account.id,
      stocked.productId,
      orgA,
    ]);

    const before = await getValuation(agentA);
    expect(before.misplaced).toHaveLength(1);

    const reclass = await agentA.post(`${STOCK}/reconcile/reclass`).send({});
    expect(reclass.status).toBe(200);
    expect(reclass.body.postingCount).toBe(1);

    const after = await getValuation(agentA);
    expect(after.tiesOut).toBe(true);
    expect(after.misplaced).toHaveLength(0);
  });
});

describe('asOf', () => {
  it('asOf excludes later movements on both sides', async () => {
    const stocked = await createStockedItem(agentA, orgA);
    await receiveViaBill(agentA, orgA, stocked, 10, 1000, '2026-03-01', 'B-1');
    await receiveViaBill(agentA, orgA, stocked, 5, 1000, '2026-04-01', 'B-2');

    const valuation = await getValuation(agentA, '2026-03-15');
    const row = valuation.accounts.find((a) => a.code === '1140');
    expect(row?.subledgerCents).toBe(10_000);
    expect(row?.glCents).toBe(10_000);
    expect(row?.differenceCents).toBe(0);

    const full = await getValuation(agentA);
    const fullRow = full.accounts.find((a) => a.code === '1140');
    expect(fullRow?.subledgerCents).toBe(15_000);
  });
});

describe('summary', () => {
  it('summary splits linked and unlinked value', async () => {
    const linked = await createStockedItem(agentA, orgA, 'Linked');
    await agentA.post(`${STOCK}/receipts`).send({
      occurredOn: '2026-03-01',
      locationId: linked.locationId,
      lines: [{ itemId: linked.stockItemId, quantityMilli: 4000, unitCostCents: 250 }],
    });

    const unlinked = await createStockedItem(agentA, orgA, 'Unlinked');
    await pool.query('ALTER TABLE stock_items DISABLE TRIGGER trg_stock_items_ledger_link_frozen');
    await pool.query('UPDATE stock_items SET ledger_item_id = NULL WHERE id = $1', [unlinked.stockItemId]);
    await pool.query('ALTER TABLE stock_items ENABLE TRIGGER trg_stock_items_ledger_link_frozen');
    await pool.query('DELETE FROM items WHERE id = $1', [unlinked.productId]);
    await agentA.post(`${STOCK}/receipts`).send({
      occurredOn: '2026-03-01',
      locationId: unlinked.locationId,
      lines: [{ itemId: unlinked.stockItemId, quantityMilli: 2000, unitCostCents: 300 }],
    });

    const res = await agentA.get(`${STOCK}/summary`);
    expect(res.status).toBe(200);
    expect(res.body.summary.linkedValueCents).toBe(1000);
    expect(res.body.summary.unlinkedValueCents).toBe(600);
    expect(res.body.summary.unlinkedItemCount).toBe(1);
  });
});
