import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { runIntegrityChecks } from '../../db/integrity.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Accounting — the `INVENTORY_ITEMS` import kind (Phase 36b): tracked items,
 * their linked products and opening stock created from a CSV in one
 * transaction, crossing into Inventory only through its document seam.
 * Integration tier, real PostgreSQL; includes the cross-tenant case (rule 15).
 */

const app = createApp();
const IMPORTS = '/api/v1/migration-imports';
const STOCK_ITEMS = '/api/v1/inventory/items';

type Agent = Awaited<ReturnType<typeof loginAgent>>;
type StagedRow = { id: string; status: string; errors: string[]; values: Record<string, unknown> };

let userA: SeededUser;
let userC: SeededUser;
let agentA: Agent;
let agentC: Agent;

async function onboard(agent: Agent): Promise<void> {
  const res = await agent.post('/api/v1/settings/onboarding').send({
    organizationName: 'Acme Books',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    booksStartDate: '2026-01-01',
  });
  if (res.status !== 200) throw new Error(`fixture: onboarding failed ${String(res.status)}`);
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'inv-a', orgName: 'Inventory Import Org A' });
  userC = await createUserWithOrg({ label: 'inv-c', orgName: 'Inventory Import Org C' });
  agentA = await loginAgent(app, userA);
  agentC = await loginAgent(app, userC);
  await onboard(agentA);
  await onboard(agentC);
});

afterAll(closePool);

async function stage(content: string, extra: Record<string, unknown> = {}, agent: Agent = agentA) {
  return agent.post(IMPORTS).send({ kind: 'INVENTORY_ITEMS', fileName: 'stock.csv', content, ...extra });
}

async function stageAndValidate(
  content: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; rows: StagedRow[] }> {
  const staged = await stage(content, extra);
  expect(staged.status).toBe(201);
  const id = staged.body.import.id as string;
  const validated = await agentA.post(`${IMPORTS}/${id}/validate`);
  expect(validated.status).toBe(200);
  const rows = await agentA.get(`${IMPORTS}/${id}/rows`);
  return { id, rows: rows.body.rows as StagedRow[] };
}

async function setUpInventory(agent: Agent): Promise<void> {
  const res = await agent.post('/api/v1/inventory/setup').send({ industryProfile: 'GENERAL' });
  expect(res.status).toBe(200);
}

const HEADER = 'ItemCode,*ItemName,Category,PurchasesUnitPrice,OpeningQuantity,OpeningUnitCost,OpeningDate';
const TWO_ROWS = `${HEADER}\nBLUE-01,Blue widget,,,40,11.50,2026-01-15\nRED-01,Red widget,,3.00,,,`;

describe('staging, validation and preview', () => {
  it('stages VALID and previews opening value', async () => {
    const { id, rows } = await stageAndValidate(TWO_ROWS);

    expect(rows.map((r) => r.errors)).toEqual([[], []]);
    const preview = await agentA.get(`${IMPORTS}/${id}/preview`);
    expect(preview.status).toBe(200);
    const p = preview.body.preview as { summary: unknown[]; warnings: string[]; blockingErrorCount: number };
    expect(p.blockingErrorCount).toBe(0);
    expect(p.summary).toContainEqual({ label: 'Opening stock value', value: 46000, format: 'money' });
    expect(p.warnings).toHaveLength(1);
  });

  it('an existing product code is refused with the Track-inventory pointer', async () => {
    await agentA.post('/api/v1/items').send({ code: 'WIDGET', name: 'Plain product', kind: 'SERVICE' });

    const { rows } = await stageAndValidate('ItemCode,*ItemName\nwidget,Widget');

    expect(rows[0]?.errors).toContain(
      '"WIDGET" already exists — to track stock for an existing product, open it in Products & Services and tick Track inventory',
    );
  });

  it('an unknown category names the setup hint when inventory is not set up', async () => {
    const { rows } = await stageAndValidate('*ItemName,Category\nWidget,Nope');

    expect(rows[0]?.errors).toContain(
      'Category "Nope" was not found. Leave it blank to use your default, or set up inventory first (Inventory → Setup)',
    );
  });

  it('a lot-tracked category refuses opening stock', async () => {
    await setUpInventory(agentA);
    const cat = await agentA
      .post('/api/v1/inventory/categories')
      .send({ code: 'LOTCAT', name: 'Lot goods', itemType: 'TRADING_GOOD', defaultTracking: 'LOT' });
    expect(cat.status).toBe(201);

    const { rows } = await stageAndValidate(
      '*ItemName,Category,OpeningQuantity,OpeningUnitCost,OpeningDate\nBatch thing,LOTCAT,5,1.00,2026-01-15',
    );

    expect(rows[0]?.errors).toContain('Opening stock for lot- or serial-tracked items goes in under Stock movements → Receive');
  });

  it('a future opening date is a row error', async () => {
    const { rows } = await stageAndValidate(
      '*ItemName,OpeningQuantity,OpeningUnitCost,OpeningDate\nWidget,5,1.00,2999-01-01',
    );

    expect(rows[0]?.errors).toContain('Opening date cannot be in the future');
  });

  it('missing unit cost and purchase price is a row error', async () => {
    const { rows } = await stageAndValidate('*ItemName,OpeningQuantity,OpeningDate\nWidget,5,2026-01-15');

    expect(rows[0]?.errors).toContain('Enter an OpeningUnitCost or a PurchasesUnitPrice for the opening stock');
  });

  it('DMY dates parse with dateFormat', async () => {
    const res = await stage('*ItemName,OpeningQuantity,OpeningUnitCost,OpeningDate\nWidget,5,1.00,31/01/2026', {
      dateFormat: 'DMY',
    });

    expect(res.status).toBe(201);
    const rows = await agentA.get(`${IMPORTS}/${res.body.import.id as string}/rows`);
    expect((rows.body.rows as StagedRow[])[0]?.values.openingDate).toBe('2026-01-31');
  });

  it('inspect suggests DMY for an unambiguous day-first file', async () => {
    const res = await agentA.post(`${IMPORTS}/inspect`).send({
      kind: 'INVENTORY_ITEMS',
      content: '*ItemName,OpeningQuantity,OpeningUnitCost,OpeningDate\nWidget,5,1.00,31/01/2026',
    });

    expect(res.status).toBe(200);
    expect(res.body.inspection.suggestedDateFormat).toBe('DMY');
  });
});

describe('commit', () => {
  it('commit sets up inventory, creates items, products and opening stock', async () => {
    const { id } = await stageAndValidate(TWO_ROWS);

    const started = Date.now();
    const commit = await agentA.post(`${IMPORTS}/${id}/commit`);
    const elapsedMs = Date.now() - started;
    console.log(`[timing] INVENTORY_ITEMS commit of 2 rows (1 opening receipt): ${String(elapsedMs)} ms`);

    expect(commit.status).toBe(200);
    expect(commit.body.result).toEqual({ kind: 'INVENTORY_ITEMS', createdCount: 2, openingStockCount: 1 });

    const stock = await agentA.get(STOCK_ITEMS);
    const stockItems = stock.body.items as { id: string; code: string }[];
    expect(stockItems.map((i) => i.code).sort()).toEqual(['BLUE-01', 'RED-01']);

    const products = await agentA.get('/api/v1/items?itemType=INVENTORY');
    expect((products.body.items as { code: string }[]).map((i) => i.code).sort()).toEqual(['BLUE-01', 'RED-01']);

    const blue = stockItems.find((i) => i.code === 'BLUE-01');
    const balances = await agentA.get(`/api/v1/inventory/balances?itemId=${blue?.id as string}`);
    expect(balances.body.balances[0].quantityMilli).toBe(40000);
  });

  it('integrity checks pass after an opening-stock import', async () => {
    const { id } = await stageAndValidate(TWO_ROWS);
    const commit = await agentA.post(`${IMPORTS}/${id}/commit`);
    expect(commit.status).toBe(200);

    const report = await runIntegrityChecks();

    for (const name of [
      'stock_balances_match_movements',
      'stock_movements_reconcile_with_gl',
      'inventory_accounts_reconcile_with_gl',
    ]) {
      const check = report.checks.find((c) => c.name === name);
      expect(check?.passed, name).toBe(true);
    }
  });

  it('all-or-nothing: a bad barcode caught at commit rolls back every row', async () => {
    await setUpInventory(agentA);
    const existing = await agentA.post(STOCK_ITEMS).send({ name: 'Existing', barcode: '4006381333931' });
    expect(existing.status).toBe(201);

    const { id } = await stageAndValidate(
      'ItemCode,*ItemName,Barcode\nFIRST-01,First,\nSECOND-01,Second,4006381333931',
    );
    const commit = await agentA.post(`${IMPORTS}/${id}/commit`);

    expect(commit.status).toBe(409);
    const first = await agentA.get(`${STOCK_ITEMS}?q=FIRST-01`);
    const second = await agentA.get(`${STOCK_ITEMS}?q=SECOND-01`);
    expect(first.body.items).toHaveLength(0);
    expect(second.body.items).toHaveLength(0);
    const after = await agentA.get(`${IMPORTS}/${id}`);
    expect(after.body.import.status).toBe('VALIDATED');
  });
});

describe('cross-tenant isolation (rule 15)', () => {
  it("cross-tenant: org B's categories and locations do not resolve; org B cannot commit org A's import", async () => {
    await setUpInventory(agentC);
    const cat = await agentC
      .post('/api/v1/inventory/categories')
      .send({ code: 'CCAT', name: 'C goods', itemType: 'TRADING_GOOD', defaultTracking: 'QUANTITY' });
    expect(cat.status).toBe(201);
    const loc = await agentC.post('/api/v1/inventory/locations').send({ code: 'CWH', name: 'C warehouse', kind: 'WAREHOUSE' });
    expect(loc.status).toBe(201);

    const { id, rows } = await stageAndValidate(
      '*ItemName,Category,OpeningLocation\nWidget,CCAT,CWH',
    );

    const errors = rows[0]?.errors ?? [];
    expect(errors.some((e) => e.startsWith('Category "CCAT" was not found'))).toBe(true);
    expect(errors.some((e) => e.startsWith('Opening location "CWH" was not found'))).toBe(true);

    const commit = await agentC.post(`${IMPORTS}/${id}/commit`);
    expect(commit.status).toBe(404);
    const peek = await agentC.get(`${IMPORTS}/${id}`);
    expect(peek.status).toBe(404);
  });
});
