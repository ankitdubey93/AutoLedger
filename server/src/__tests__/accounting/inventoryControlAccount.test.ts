import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Phase 35a — inventory accounts become control accounts (Core model §2):
 * every place that already refuses a direct posting to AR/AP refuses one to
 * an org's inventory control account too, once an INVENTORY product makes
 * that account a control account. Integration tier, real PostgreSQL.
 * Includes this guard's own cross-tenant case (rule 15).
 */

const app = createApp();
const STOCK = '/api/v1/inventory';
const JOURNALS = '/api/v1/journals';
const ACCOUNTS = '/api/v1/accounts';
const SETTINGS = '/api/v1/settings';
const ITEMS = '/api/v1/items';
const BANK_RULES = '/api/v1/bank-rules';
const RECURRING = '/api/v1/recurring-schedules';
const IMPORTS = '/api/v1/migration-imports';
const DEBIT_NOTES = '/api/v1/debit-notes';
const VENDORS = '/api/v1/vendors';
const BILLS = '/api/v1/bills';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;
let agentA: Agent;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
}

async function entryCount(orgId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM journal_entries WHERE org_id = $1',
    [orgId],
  );
  return Number(rows[0]?.n ?? '0');
}

function journalPayload(debitAccountId: string, creditAccountId: string, amountCents: number) {
  return {
    entryDate: '2026-06-01',
    description: 'inventory control account fixture',
    lines: [
      { accountId: debitAccountId, debitCents: amountCents, creditCents: 0 },
      { accountId: creditAccountId, debitCents: 0, creditCents: amountCents },
    ],
  };
}

/** Applies the GENERAL stock profile and creates one QUANTITY item (EA) — which also creates its linked product. */
async function createStockedItem(agent: Agent, orgId: string, name = 'Widget'): Promise<{ stockItemId: string; productId: string }> {
  await agent.post(`${STOCK}/setup`).send({ industryProfile: 'GENERAL' });
  const { rows: cat } = await pool.query<{ id: string }>("SELECT id FROM stock_categories WHERE org_id = $1 AND code = 'GEN'", [orgId]);
  const revenue = await accountId(orgId, '4100');
  const res = await agent.post(`${STOCK}/items`).send({
    name,
    categoryId: cat[0]?.id,
    attributes: {},
    product: { salePriceCents: 2500, purchasePriceCents: 1000, revenueAccountId: revenue },
  });
  expect(res.status).toBe(201);
  return { stockItemId: res.body.item.id as string, productId: res.body.item.ledgerItemId as string };
}

async function onboard(agent: Agent): Promise<void> {
  const res = await agent.post(`${SETTINGS}/onboarding`).send({
    organizationName: 'Acme Books',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    booksStartDate: '2026-01-01',
  });
  if (res.status !== 200) throw new Error(`fixture: onboarding failed ${res.status} ${JSON.stringify(res.body)}`);
}

async function createVendor(agent: Agent, name: string): Promise<string> {
  const res = await agent.post(VENDORS).send({ name });
  if (res.status !== 201) throw new Error(`fixture: vendor create failed ${res.status} ${res.text}`);
  return res.body.vendor.id as string;
}

/** A POSTED bill on a plain expense account (no inventory item), one line at `unitPriceCents`. */
async function approvedPlainBill(agent: Agent, orgId: string, vendorId: string, unitPriceCents: number): Promise<string> {
  const created = await agent.post(BILLS).send({
    vendorId,
    vendorReference: 'CTRL-1',
    billDate: '2026-09-01',
    dueDate: '2026-12-31',
    notes: null,
    paymentTerms: null,
    lines: [
      {
        description: 'Steel bars',
        quantityMilli: 1000,
        unitPriceCents,
        expenseAccountId: await accountId(orgId, '5100'),
        taxRateBp: 0,
      },
    ],
  });
  if (created.status !== 201) throw new Error(`fixture: bill create failed ${created.status} ${created.text}`);
  const id = created.body.bill.id as string;
  const submitted = await agent.post(`${BILLS}/${id}/submit`).send({});
  if (submitted.status !== 200) throw new Error(`fixture: bill submit failed ${submitted.status} ${submitted.text}`);
  const approved = await agent.post(`${BILLS}/${id}/approve`).send({});
  if (approved.status !== 200) throw new Error(`fixture: bill approve failed ${approved.status} ${approved.text}`);
  return id;
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'ctrl-a', orgName: 'Control Org A' });
  userB = await createUserWithOrg({ label: 'ctrl-b', orgName: 'Control Org B' });
  orgA = userA.orgId;
  orgB = userB.orgId;
  agentA = await loginAgent(app, userA);
});

afterAll(closePool);

describe('inventory control account guard — journals', () => {
  it('with an INVENTORY product, a manual journal to 1140 is refused', async () => {
    await createStockedItem(agentA, orgA);
    const before = await entryCount(orgA);

    const res = await agentA
      .post(JOURNALS)
      .send(journalPayload(await accountId(orgA, '1140'), await accountId(orgA, '4100'), 5000));

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('inventory control account');
    expect(await entryCount(orgA)).toBe(before);
  });

  it('without any INVENTORY product, a manual journal to 1140 is allowed', async () => {
    const res = await agentA
      .post(JOURNALS)
      .send(journalPayload(await accountId(orgA, '1140'), await accountId(orgA, '4100'), 5000));

    expect(res.status).toBe(201);
  });

  it('a product-level override account becomes a control account', async () => {
    await createStockedItem(agentA, orgA);
    const created = await agentA.post(ACCOUNTS).send({
      code: '1135',
      name: 'Retail Inventory',
      type: 'Asset',
      parentId: await accountId(orgA, '1100'),
    });
    expect(created.status).toBe(201);
    const overrideAccountId = created.body.account.id as string;

    const { productId } = await createStockedItem(agentA, orgA, 'Widget Two');
    const patched = await agentA.patch(`${ITEMS}/${productId}`).send({ assetAccountId: overrideAccountId });
    expect(patched.status).toBe(200);

    const res = await agentA
      .post(JOURNALS)
      .send(journalPayload(overrideAccountId, await accountId(orgA, '4100'), 3000));
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('inventory control account');
  });

  it('reversing a pre-existing manual journal to 1140 is still allowed', async () => {
    // Posted while 1140 was not yet a control account.
    const created = await agentA
      .post(JOURNALS)
      .send(journalPayload(await accountId(orgA, '1140'), await accountId(orgA, '4100'), 5000));
    expect(created.status).toBe(201);
    const legacyId = created.body.entry.id as string;

    await createStockedItem(agentA, orgA);

    const res = await agentA.post(`${JOURNALS}/${legacyId}/reverse`).send({});
    expect(res.status).toBe(201);
  });
});

describe('inventory control account guard — bank rules and recurring documents', () => {
  it('a bank rule targeting 1140 is refused', async () => {
    await createStockedItem(agentA, orgA);
    const res = await agentA.post(BANK_RULES).send({
      name: 'Bad rule',
      memoContains: 'STOCK',
      targetAccountId: await accountId(orgA, '1140'),
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('inventory control account');
  });

  it('a recurring journal to 1140 is refused', async () => {
    // Posted while 1140 was not yet a control account.
    const created = await agentA
      .post(JOURNALS)
      .send(journalPayload(await accountId(orgA, '1140'), await accountId(orgA, '4100'), 5000));
    expect(created.status).toBe(201);
    const legacyId = created.body.entry.id as string;

    await createStockedItem(agentA, orgA);

    const res = await agentA.post(RECURRING).send({
      kind: 'JOURNAL',
      sourceId: legacyId,
      name: 'Bad recurring journal',
      frequency: 'MONTHLY',
      startDate: today(),
      mode: 'POST',
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('inventory control account');
  });
});

describe('inventory control account guard — opening balances and debit notes', () => {
  it('an opening-balance import row on 1140 is refused', async () => {
    await onboard(agentA);
    await createStockedItem(agentA, orgA);

    const content = ['Code,Debit,Credit', '1140,1000.00,'].join('\n');
    const created = await agentA.post(IMPORTS).send({ kind: 'OPENING_BALANCES', fileName: 'stock.csv', content });
    expect(created.status).toBe(201);
    const rows = created.body.rows as { accountCode: string | null; errors: string[] }[];
    const row = rows.find((r) => r.accountCode === '1140');
    expect(row).toBeDefined();
    expect(row?.errors.some((e) => e.includes('inventory control account'))).toBe(true);
  });

  it('a debit-note line on 1140 is refused', async () => {
    await createStockedItem(agentA, orgA);
    const vendorId = await createVendor(agentA, 'Vendor CTRL');
    const billId = await approvedPlainBill(agentA, orgA, vendorId, 20000);

    const res = await agentA.post(DEBIT_NOTES).send({
      billId,
      issueDate: '2026-09-05',
      reasonCode: 'RETURN',
      reason: 'returned goods',
      vendorCreditReference: 'CR-1',
      notes: null,
      lines: [
        {
          description: 'Returned bars',
          quantityMilli: 1000,
          unitPriceCents: 20000,
          expenseAccountId: await accountId(orgA, '1140'),
          taxRateBp: 0,
        },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('credits an inventory account');
  });

  it('a free-typed bill line on 1140 is refused at approval', async () => {
    await createStockedItem(agentA, orgA);
    const vendorId = await createVendor(agentA, 'Vendor CTRL2');
    const created = await agentA.post(BILLS).send({
      vendorId,
      vendorReference: 'CTRL-2',
      billDate: '2026-09-01',
      dueDate: '2026-12-31',
      notes: null,
      paymentTerms: null,
      lines: [
        {
          description: 'Loose part',
          quantityMilli: 1000,
          unitPriceCents: 300,
          expenseAccountId: await accountId(orgA, '1140'),
          itemId: null,
        },
      ],
    });
    expect(created.status).toBe(201);
    const billId = created.body.bill.id as string;

    const res = await agentA.post(`${BILLS}/${billId}/approve`).send({});
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('only inventory items may use on a bill');
  });
});

describe('settings — the four inventory accounts', () => {
  beforeEach(async () => {
    await onboard(agentA);
  });

  it('PATCH /settings inventory accounts round-trip', async () => {
    const inventoryAccountId = await accountId(orgA, '1130');
    const cogsAccountId = await accountId(orgA, '5100');
    const inventoryAdjustmentAccountId = await accountId(orgA, '6120');
    const stockOpeningAccountId = await accountId(orgA, '3300');

    const patched = await agentA.patch(SETTINGS).send({
      inventoryAccountId,
      cogsAccountId,
      inventoryAdjustmentAccountId,
      stockOpeningAccountId,
    });
    expect(patched.status).toBe(200);

    const res = await agentA.get(SETTINGS);
    expect(res.status).toBe(200);
    expect(res.body.settings.inventoryAccountId).toBe(inventoryAccountId);
    expect(res.body.settings.cogsAccountId).toBe(cogsAccountId);
    expect(res.body.settings.inventoryAdjustmentAccountId).toBe(inventoryAdjustmentAccountId);
    expect(res.body.settings.stockOpeningAccountId).toBe(stockOpeningAccountId);
  });

  it('wrong type is refused', async () => {
    const res = await agentA.patch(SETTINGS).send({ inventoryAccountId: await accountId(orgA, '4100') });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Inventory account must be a Asset account');
  });

  it('a header account is refused', async () => {
    const res = await agentA.patch(SETTINGS).send({ inventoryAccountId: await accountId(orgA, '1100') });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Inventory account must be postable');
  });

  it("org B's account id is refused", async () => {
    const res = await agentA.patch(SETTINGS).send({ inventoryAccountId: await accountId(orgB, '1140') });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Inventory account does not exist in this organization');
  });
});

describe('cross-tenant isolation', () => {
  it("org B's journal to its own 1140 is unaffected by org A's products", async () => {
    await createStockedItem(agentA, orgA);
    const agentB = await loginAgent(app, userB);

    const res = await agentB
      .post(JOURNALS)
      .send(journalPayload(await accountId(orgB, '1140'), await accountId(orgB, '4100'), 5000));
    expect(res.status).toBe(201);
  });
});
