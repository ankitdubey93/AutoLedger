import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Accounting — the `ITEMS` import kind (Phase 36b): Products & Services staged
 * into JSONB `data`, validated against the org's accounts and products, then
 * committed (create new / fill blanks). Integration tier, real PostgreSQL.
 * Includes this slice's cross-tenant isolation case (rule 15).
 */

const app = createApp();
const IMPORTS = '/api/v1/migration-imports';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let userC: SeededUser;
let orgA: string;
let agentA: Agent;
let agentC: Agent;

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'item-a', orgName: 'Item Import Org A' });
  userC = await createUserWithOrg({ label: 'item-c', orgName: 'Item Import Org C' });
  orgA = userA.orgId;
  agentA = await loginAgent(app, userA);
  agentC = await loginAgent(app, userC);
});

afterAll(closePool);

async function stage(content: string) {
  return agentA.post(IMPORTS).send({ kind: 'ITEMS', fileName: 'items.csv', content });
}

async function stageAndValidate(content: string): Promise<{ id: string; rows: { id: string; status: string; errors: string[]; values: Record<string, unknown> }[] }> {
  const staged = await stage(content);
  expect(staged.status).toBe(201);
  const id = staged.body.import.id as string;
  const validated = await agentA.post(`${IMPORTS}/${id}/validate`);
  expect(validated.status).toBe(200);
  const rows = await agentA.get(`${IMPORTS}/${id}/rows`);
  return { id, rows: rows.body.rows };
}

async function accountCodeToId(org: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id = $1 AND code = $2', [org, code]);
  const row = rows[0];
  if (row === undefined) throw new Error(`account ${code} missing`);
  return row.id;
}

const HEADER = '*ItemCode,*ItemName,Type,SalesUnitPrice,SalesAccount,SalesTaxRate';

describe('staging and validation', () => {
  it('a Products & Services CSV stages VALID with parsed values', async () => {
    const res = await stage(`${HEADER}\nCONS,Consulting,Service,150.00,4100,10%`);

    expect(res.status).toBe(201);
    expect(res.body.import.errorCount).toBe(0);

    const rows = await agentA.get(`${IMPORTS}/${res.body.import.id as string}/rows`);
    const values = rows.body.rows[0].values as Record<string, unknown>;
    expect(values).toMatchObject({
      itemCode: 'CONS',
      itemName: 'Consulting',
      itemType: 'SERVICE',
      salePrice: 15000,
      salesAccount: '4100',
      salesTaxRate: 1000,
      description: null,
      purchasePrice: null,
      purchasesAccount: null,
      purchasesTaxRate: null,
    });
  });

  it('unparseable cells are row errors naming the column', async () => {
    const { rows } = await stageAndValidate(`${HEADER}\nCONS,Consulting,Service,abc,4100,10`);

    expect(rows[0]?.status).toBe('INVALID');
    expect(rows[0]?.errors).toContain('Sale price "abc" is not an amount');
  });

  it('duplicate codes in the file flag both rows', async () => {
    const { rows } = await stageAndValidate(`${HEADER}\nDUP,One,Service,,,\nDUP,Two,Service,,,`);

    const expected = 'Item code "DUP" appears more than once in this file (rows 2, 3)';
    expect(rows[0]?.errors).toContain(expected);
    expect(rows[1]?.errors).toContain(expected);
  });

  it('a sales account of the wrong type is a row error', async () => {
    const { rows } = await stageAndValidate(`${HEADER}\nCONS,Consulting,Service,10,1110,`);

    expect(rows[0]?.errors).toContain('SalesAccount "1110" must be a Revenue account');
  });

  it('Type Inventory is refused with a pointer to Inventory import', async () => {
    const { rows } = await stageAndValidate(`${HEADER}\nWIDGET,Widget,Inventory,,,`);

    expect(rows[0]?.errors).toContain('"WIDGET" is a tracked inventory item — import it under Inventory → Import');
  });
});

describe('commit', () => {
  it('commit creates new products with derived type', async () => {
    const { id } = await stageAndValidate('*ItemCode,*ItemName,PurchasesUnitPrice\nBOLT,Bolt,2.50');

    const commit = await agentA.post(`${IMPORTS}/${id}/commit`);

    expect(commit.status).toBe(200);
    expect(commit.body.result).toEqual({ kind: 'ITEMS', createdCount: 1, mergedCount: 0 });
    const list = await agentA.get('/api/v1/items');
    const item = (list.body.items as { code: string; itemType: string; purchasePriceCents: number; saleTaxRateBp: number }[]).find(
      (i) => i.code === 'BOLT',
    );
    expect(item?.itemType).toBe('NON_INVENTORY');
    expect(item?.purchasePriceCents).toBe(250);
    expect(item?.saleTaxRateBp).toBe(0);
  });

  it('commit fills only blank fields of an existing product', async () => {
    const created = await agentA
      .post('/api/v1/items')
      .send({ code: 'CONS', name: 'Original name', kind: 'SERVICE', salePriceCents: 10000 });
    expect(created.status).toBe(201);

    const { id } = await stageAndValidate(
      '*ItemCode,*ItemName,SalesUnitPrice,Description\nCONS,Different name,200.00,Filled description',
    );
    const commit = await agentA.post(`${IMPORTS}/${id}/commit`);

    expect(commit.status).toBe(200);
    expect(commit.body.result).toEqual({ kind: 'ITEMS', createdCount: 0, mergedCount: 1 });
    const item = (await agentA.get(`/api/v1/items/${created.body.item.id as string}`)).body.item as {
      name: string;
      salePriceCents: number;
      description: string | null;
    };
    expect(item.name).toBe('Original name');
    expect(item.salePriceCents).toBe(10000);
    expect(item.description).toBe('Filled description');
  });

  it('commit revalidates: an account deactivated after validation blocks commit', async () => {
    const acct = await agentA.post('/api/v1/accounts').send({ code: '4777', name: 'Fresh revenue', type: 'Revenue' });
    expect(acct.status).toBe(201);
    const { id } = await stageAndValidate(`${HEADER}\nFRESH,Fresh,Service,10,4777,`);

    await pool.query('UPDATE accounts SET is_active = false WHERE org_id = $1 AND id = $2', [
      orgA,
      acct.body.account.id as string,
    ]);
    const commit = await agentA.post(`${IMPORTS}/${id}/commit`);

    expect(commit.status).toBe(409);
    expect(commit.body.error).toContain('became invalid since validation');
    const { rows } = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM items WHERE org_id = $1 AND code = 'FRESH'",
      [orgA],
    );
    expect(rows[0]?.count).toBe('0');
  });
});

describe('PATCH values', () => {
  it('PATCH values fixes a bad cell and revalidates', async () => {
    const { id, rows } = await stageAndValidate(`${HEADER}\nCONS,Consulting,Service,abc,4100,`);
    expect(rows[0]?.status).toBe('INVALID');

    const res = await agentA.patch(`${IMPORTS}/${id}/rows/${rows[0]?.id as string}`).send({ values: { salePrice: '99.50' } });

    expect(res.status).toBe(200);
    expect(res.body.row.status).toBe('VALID');
    expect(res.body.row.values.salePrice).toBe(9950);
    expect(res.body.import.status).toBe('VALIDATED');
  });

  it('PATCH with a legacy key on a data kind is 400', async () => {
    const { id, rows } = await stageAndValidate(`${HEADER}\nCONS,Consulting,Service,10,4100,`);

    const res = await agentA.patch(`${IMPORTS}/${id}/rows/${rows[0]?.id as string}`).send({ accountCode: '1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Edit this import with "values"');
  });

  it('PATCH values with an unknown field is 400', async () => {
    const { id, rows } = await stageAndValidate(`${HEADER}\nCONS,Consulting,Service,10,4100,`);

    const res = await agentA.patch(`${IMPORTS}/${id}/rows/${rows[0]?.id as string}`).send({ values: { bogus: 'x' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unknown field "bogus"');
  });
});

describe('cross-tenant isolation (rule 15)', () => {
  it("cross-tenant: org B's account codes and products do not resolve", async () => {
    const acct = await agentC.post('/api/v1/accounts').send({ code: '4999', name: 'C revenue', type: 'Revenue' });
    expect(acct.status).toBe(201);
    await agentC.post('/api/v1/items').send({ code: 'SHARED', name: 'C product', kind: 'SERVICE' });

    const { id, rows } = await stageAndValidate(`${HEADER}\nSHARED,A product,Service,10,4999,`);

    expect(rows[0]?.errors.some((e) => e.includes('was not found'))).toBe(true);
    const preview = await agentA.get(`${IMPORTS}/${id}/preview`);
    const summary = preview.body.preview.summary as { label: string; value: number }[];
    expect(summary.find((s) => s.label === 'Products to create')?.value).toBe(1);
    expect(summary.find((s) => s.label === 'Existing products to fill in')?.value).toBe(0);

    const peek = await agentC.get(`${IMPORTS}/${id}`);
    expect(peek.status).toBe(404);
    expect(await accountCodeToId(orgA, '4100')).not.toBe('');
  });
});
