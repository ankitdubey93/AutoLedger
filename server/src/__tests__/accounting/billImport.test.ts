import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { runIntegrityChecks } from '../../db/integrity.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Accounting — the grouped `BILLS` import kind (Phase 36d), shown in the UI as
 * "Expenses": CSV rows become vendor bills, kept as drafts or approved in the
 * same transaction, optionally in conversion mode (posted to 3400 on the
 * conversion date). Integration tier, real PostgreSQL. Includes this slice's
 * cross-tenant isolation case (rule 15).
 */

const app = createApp();
const IMPORTS = '/api/v1/migration-imports';
const ONBOARDING = '/api/v1/settings/onboarding';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

interface Row {
  id: string;
  rowNumber: number;
  status: string;
  errors: string[];
  groupKey: string | null;
}

let userA: SeededUser;
let userB: SeededUser;
let agentA: Agent;
let agentB: Agent;

async function onboard(agent: Agent): Promise<void> {
  const res = await agent.post(ONBOARDING).send({
    organizationName: 'Bill Import Books',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    booksStartDate: '2026-01-01',
  });
  if (res.status !== 200) throw new Error(`fixture: onboarding failed ${String(res.status)} ${res.text}`);
}

async function vendor(agent: Agent, name: string, email: string | null = null): Promise<string> {
  const res = await agent.post('/api/v1/vendors').send({ name, email });
  if (res.status !== 201) throw new Error(`fixture: vendor failed ${String(res.status)} ${res.text}`);
  return res.body.vendor.id as string;
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'billimp-a', orgName: 'Bill Import Org A' });
  userB = await createUserWithOrg({ label: 'billimp-b', orgName: 'Bill Import Org B' });
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  await onboard(agentA);
  await onboard(agentB);
});

afterAll(closePool);

const HEADER =
  '*ContactName,EmailAddress,*InvoiceNumber,*InvoiceDate,DueDate,PaymentTerms,ItemCode,*Description,Quantity,UnitAmount,AccountCode,TaxRate';

interface Line {
  contact?: string;
  email?: string;
  num?: string;
  date?: string;
  due?: string;
  terms?: string;
  item?: string;
  desc?: string;
  qty?: string;
  price?: string;
  acct?: string;
  tax?: string;
}

function csv(...lines: Line[]): string {
  return [
    HEADER,
    ...lines.map((l) =>
      [
        l.contact ?? 'Supply Co',
        l.email ?? '',
        l.num ?? 'SUP-1',
        l.date ?? '2026-03-10',
        l.due ?? '2026-04-09',
        l.terms ?? '',
        l.item ?? '',
        l.desc ?? 'Parts',
        l.qty ?? '1',
        l.price ?? '100.00',
        l.acct ?? '6100',
        l.tax ?? '',
      ].join(','),
    ),
  ].join('\n');
}

async function stageOk(content: string, extra: Record<string, unknown> = {}, agent: Agent = agentA): Promise<string> {
  const res = await agent.post(IMPORTS).send({ kind: 'BILLS', fileName: 'bills.csv', content, ...extra });
  if (res.status !== 201) throw new Error(`fixture: stage failed ${String(res.status)} ${res.text}`);
  return res.body.import.id as string;
}

async function getRows(id: string, agent: Agent = agentA): Promise<Row[]> {
  const res = await agent.get(`${IMPORTS}/${id}/rows`);
  expect(res.status).toBe(200);
  return res.body.rows as Row[];
}

async function validate(id: string, agent: Agent = agentA): Promise<void> {
  const res = await agent.post(`${IMPORTS}/${id}/validate`);
  expect(res.status).toBe(200);
}

async function stageValidated(content: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = await stageOk(content, extra);
  await validate(id);
  return id;
}

async function listBills(agent: Agent = agentA) {
  const res = await agent.get('/api/v1/bills?limit=100');
  expect(res.status).toBe(200);
  return res.body.bills as { id: string; vendorReference: string; status: string; totalCents: number }[];
}

async function net3400(orgId: string): Promise<number> {
  const { rows } = await pool.query<{ net: string | null }>(
    `SELECT (SUM(l.credit_cents) - SUM(l.debit_cents))::text AS net
       FROM ledger_lines l JOIN accounts a ON a.id = l.account_id
      WHERE a.org_id = $1 AND a.code = '3400'`,
    [orgId],
  );
  return Number(rows[0]?.net ?? '0');
}

describe('staging and validation', () => {
  it('rows sharing vendor and InvoiceNumber stage as one expense', async () => {
    await vendor(agentA, 'Supply Co');
    const id = await stageValidated(csv({ num: 'SUP-1', price: '100.00' }, { num: 'SUP-1', price: '25.00', qty: '2' }));

    const rows = await getRows(id);
    expect(rows.map((r) => r.errors)).toEqual([[], []]);
    expect(new Set(rows.map((r) => r.groupKey)).size).toBe(1);
    const preview = await agentA.get(`${IMPORTS}/${id}/preview`);
    expect(preview.status).toBe(200);
    const summary = preview.body.preview.summary as { label: string; value: number }[];
    expect(summary.find((s) => s.label === 'Expenses')?.value).toBe(1);
    expect(summary.find((s) => s.label === 'Lines')?.value).toBe(2);
    expect(summary.find((s) => s.label === 'Total (base-currency documents)')?.value).toBe(15000);
  });

  it('the same reference from two vendors stays two expenses', async () => {
    await vendor(agentA, 'Supply Co');
    await vendor(agentA, 'Other Supplier');
    const id = await stageValidated(csv({ num: 'REF-1' }, { num: 'REF-1', contact: 'Other Supplier' }));

    const rows = await getRows(id);
    expect(rows.map((r) => r.errors)).toEqual([[], []]);
    expect(new Set(rows.map((r) => r.groupKey)).size).toBe(2);
    const preview = await agentA.get(`${IMPORTS}/${id}/preview`);
    const summary = preview.body.preview.summary as { label: string; value: number }[];
    expect(summary.find((s) => s.label === 'Expenses')?.value).toBe(2);
  });

  it('an existing vendor reference is refused', async () => {
    await vendor(agentA, 'Supply Co');
    const first = await stageValidated(csv({ num: 'SUP-9' }));
    expect((await agentA.post(`${IMPORTS}/${first}/commit`).send({})).status).toBe(200);

    const second = await stageValidated(csv({ num: 'SUP-9' }));

    const rows = await getRows(second);
    expect(rows[0]?.status).toBe('INVALID');
    expect(rows[0]?.errors).toContain('Expense SUP-9 from Supply Co already exists');
  });

  it('an Asset account is accepted on an expense line; a Revenue account is refused', async () => {
    await vendor(agentA, 'Supply Co');
    const created = await agentA.post('/api/v1/accounts').send({ code: '1999', name: 'Prepaid equipment', type: 'Asset' });
    expect(created.status).toBe(201);

    const id = await stageValidated(csv({ num: 'A-1', acct: '1999' }, { num: 'A-2', acct: '4100' }));

    const rows = await getRows(id);
    expect(rows[0]?.errors).toEqual([]);
    expect(rows[0]?.status).toBe('VALID');
    expect(rows[1]?.status).toBe('INVALID');
    expect(rows[1]?.errors).toContain('AccountCode "4100" must be an Expense or Asset account');
  });

  it('a Xero-style bill file maps InvoiceNumber and Reference to separate fields', async () => {
    const res = await agentA.post(`${IMPORTS}/inspect`).send({
      kind: 'BILLS',
      content: [
        '*ContactName,*InvoiceNumber,Reference,*InvoiceDate,DueDate,*Description,Quantity,UnitAmount,AccountCode',
        'Supply Co,SUP-1,PO 7781,2026-03-10,2026-04-09,Parts,1,100.00,6100',
      ].join('\n'),
    });

    expect(res.status).toBe(200);
    expect(res.body.inspection.suggestedMap.invoiceNumber).toBe('*InvoiceNumber');
    expect(res.body.inspection.suggestedMap.notes).toBe('Reference');
  });
});

describe('commit: drafts and posting', () => {
  it('an inventory product line defaults to its inventory account and receives stock when posted', async () => {
    await vendor(agentA, 'Supply Co');
    const setup = await agentA.post('/api/v1/inventory/setup').send({ industryProfile: 'GENERAL' });
    expect(setup.status).toBe(200);
    const { rows: cat } = await pool.query<{ id: string }>(
      "SELECT id FROM stock_categories WHERE org_id = $1 AND code = 'GEN'",
      [userA.orgId],
    );
    const { rows: rev } = await pool.query<{ id: string }>("SELECT id FROM accounts WHERE org_id = $1 AND code = '4100'", [userA.orgId]);
    const item = await agentA.post('/api/v1/inventory/items').send({
      name: 'Widget',
      categoryId: cat[0]?.id,
      attributes: {},
      product: { salePriceCents: 2500, purchasePriceCents: 1000, revenueAccountId: rev[0]?.id },
    });
    expect(item.status).toBe(201);
    const stockItemId = item.body.item.id as string;
    const { rows: prod } = await pool.query<{ code: string }>('SELECT code FROM items WHERE id = $1 AND org_id = $2', [
      item.body.item.ledgerItemId as string,
      userA.orgId,
    ]);
    const code = prod[0]?.code;
    if (code === undefined) throw new Error('fixture: no linked product');

    const id = await stageValidated(csv({ num: 'STK-1', item: code, desc: '', qty: '5', price: '', acct: '' }));
    const rows = await getRows(id);
    expect(rows[0]?.errors).toEqual([]);
    const commit = await agentA.post(`${IMPORTS}/${id}/commit`).send({ mode: 'POST' });

    expect(commit.status).toBe(200);
    const { rows: bal } = await pool.query<{ q: string; v: string }>(
      'SELECT COALESCE(SUM(quantity_milli), 0)::text AS q, COALESCE(SUM(value_cents), 0)::text AS v FROM stock_balances WHERE org_id = $1 AND item_id = $2',
      [userA.orgId, stockItemId],
    );
    expect(bal[0]?.q).toBe('5000');
    expect(bal[0]?.v).toBe('5000');
    const report = await runIntegrityChecks();
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('import as drafts lands bills in DRAFT', async () => {
    await vendor(agentA, 'Supply Co');
    const id = await stageValidated(csv({ num: 'SUP-1' }, { num: 'SUP-2' }));

    const commit = await agentA.post(`${IMPORTS}/${id}/commit`).send({ mode: 'DRAFT' });

    expect(commit.status).toBe(200);
    expect(commit.body.result).toEqual({ kind: 'BILLS', documentCount: 2, lineCount: 2, mode: 'DRAFT' });
    const bills = await listBills();
    expect(bills.map((b) => b.status)).toEqual(['DRAFT', 'DRAFT']);
    expect(bills.map((b) => b.vendorReference).sort()).toEqual(['SUP-1', 'SUP-2']);
    const ap = await agentA.get('/api/v1/reports/ap-aging?asOf=2026-03-31');
    expect(ap.body.totalOutstandingCents).toBe(0);
  });

  it('import and post approves bills on a chosen posting date', async () => {
    await vendor(agentA, 'Supply Co');
    const id = await stageValidated(csv({ num: 'SUP-1' }, { num: 'SUP-2', price: '40.00' }));

    const commit = await agentA.post(`${IMPORTS}/${id}/commit`).send({ mode: 'POST', postingDate: '2026-03-20' });

    expect(commit.status).toBe(200);
    expect(commit.body.result).toEqual({ kind: 'BILLS', documentCount: 2, lineCount: 2, mode: 'POST' });
    const bills = await listBills();
    expect(bills.map((b) => b.status)).toEqual(['POSTED', 'POSTED']);
    for (const b of bills) {
      const detail = await agentA.get(`/api/v1/bills/${b.id}`);
      const entry = await agentA.get(`/api/v1/journals/${detail.body.bill.journalEntryId as string}`);
      expect(entry.body.entry.entryDate).toBe('2026-03-20');
    }
    const tb = await agentA.get('/api/v1/reports/trial-balance');
    expect(tb.body.isBalanced).toBe(true);
  });
});

describe('conversion mode', () => {
  it('conversion mode posts bills to 3400 and AP ageing shows them', async () => {
    await vendor(agentA, 'Supply Co');
    const opening = await agentA.post(IMPORTS).send({
      kind: 'OPENING_BALANCES',
      fileName: 'tb.csv',
      content: ['Code,Debit,Credit', '1110,1000.00,', '3100,,1000.00'].join('\n'),
    });
    expect(opening.status).toBe(201);
    expect((await agentA.post(`${IMPORTS}/${opening.body.import.id as string}/commit`).send({})).status).toBe(200);

    const id = await stageValidated(
      csv({ num: 'OLD-B1', date: '2025-12-22', due: '2026-01-21', price: '300.00', acct: '', desc: 'Carried over' }),
      { conversionMode: true },
    );
    const commit = await agentA.post(`${IMPORTS}/${id}/commit`).send({});

    expect(commit.status).toBe(200);
    expect(commit.body.result).toEqual({ kind: 'BILLS', documentCount: 1, lineCount: 1, mode: 'POST' });
    const [bill] = await listBills();
    expect(bill?.status).toBe('POSTED');
    const detail = await agentA.get(`/api/v1/bills/${bill?.id as string}`);
    const entry = await agentA.get(`/api/v1/journals/${detail.body.bill.journalEntryId as string}`);
    expect(entry.body.entry.entryDate).toBe('2026-01-01');

    const aging = await agentA.get('/api/v1/reports/ap-aging?asOf=2026-02-10');
    expect(aging.body.totalOutstandingCents).toBe(30000);
    expect(aging.body.rows[0].d1to30Cents).toBe(30000);
    expect(aging.body.reconciles).toBe(true);
    const pnl = await agentA.get('/api/v1/reports/profit-and-loss?from=2026-01-01&to=2026-12-31');
    expect(pnl.body.operatingExpenses.totalCents).toBe(0);
    // The expense side of the entry sits in 3400 as a debit (the AP the opening import would have plugged).
    expect(await net3400(userA.orgId)).toBe(-30000);
  });
});

describe('tenant isolation', () => {
  it("cross-tenant: org B's vendors don't resolve; org B cannot commit org A's import", async () => {
    await vendor(agentA, 'Alpha Supplier');
    await vendor(agentB, 'Bravo Supplier');

    const idA = await stageValidated(csv({ contact: 'Bravo Supplier', num: 'X-1' }));
    const rowsA = await getRows(idA);
    expect(rowsA[0]?.status).toBe('INVALID');
    expect(rowsA[0]?.errors).toContain('Vendor "Bravo Supplier" not found — import vendors first (Vendors → Import)');

    const good = await stageValidated(csv({ contact: 'Alpha Supplier', num: 'X-2' }));
    expect((await agentB.get(`${IMPORTS}/${good}`)).status).toBe(404);
    expect((await agentB.post(`${IMPORTS}/${good}/commit`).send({ mode: 'POST' })).status).toBe(404);
    expect(await listBills(agentA)).toEqual([]);
    expect(await listBills(agentB)).toEqual([]);

    // The same vendor reference is independent per org.
    const idB = await stageOk(csv({ contact: 'Bravo Supplier', num: 'X-2' }), {}, agentB);
    await validate(idB, agentB);
    expect((await getRows(idB, agentB))[0]?.errors).toEqual([]);
  });
});
