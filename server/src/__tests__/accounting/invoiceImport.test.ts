import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, addMember, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Accounting — the grouped `INVOICES` import kind (Phase 36d): CSV rows become
 * invoices, kept as drafts or issued in the same transaction, optionally in
 * conversion mode (posted to 3400 on the conversion date). Integration tier,
 * real PostgreSQL. Includes this slice's cross-tenant isolation case (rule 15).
 */

const app = createApp();
const IMPORTS = '/api/v1/migration-imports';
const PERIODS = '/api/v1/fiscal-periods';
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
let periods: { id: string; startsOn: string }[] = [];

async function onboard(agent: Agent): Promise<void> {
  const res = await agent.post(ONBOARDING).send({
    organizationName: 'Invoice Import Books',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    booksStartDate: '2026-01-01',
  });
  if (res.status !== 200) throw new Error(`fixture: onboarding failed ${String(res.status)} ${res.text}`);
}

async function customer(agent: Agent, name: string, email: string | null = null): Promise<string> {
  const res = await agent.post('/api/v1/customers').send({ name, email });
  if (res.status !== 201) throw new Error(`fixture: customer failed ${String(res.status)} ${res.text}`);
  return res.body.customer.id as string;
}

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id = $1 AND code = $2', [orgId, code]);
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code}`);
  return row.id;
}

async function service(agent: Agent, orgId: string, code: string, priceCents: number, taxBp: number): Promise<void> {
  const res = await agent.post('/api/v1/items').send({
    code,
    name: `Service ${code}`,
    itemType: 'SERVICE',
    salePriceCents: priceCents,
    revenueAccountId: await accountId(orgId, '4100'),
    saleTaxRateBp: taxBp,
  });
  if (res.status !== 201) throw new Error(`fixture: item failed ${String(res.status)} ${res.text}`);
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'invimp-a', orgName: 'Invoice Import Org A' });
  userB = await createUserWithOrg({ label: 'invimp-b', orgName: 'Invoice Import Org B' });
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  await onboard(agentA);
  await onboard(agentB);
  const gen = await agentA.post(`${PERIODS}/generate`).send({ containingDate: '2026-06-15' });
  if (gen.status !== 201) throw new Error(`fixture: generate periods failed ${String(gen.status)}`);
  periods = gen.body.periods as { id: string; startsOn: string }[];
});

afterAll(closePool);

const HEADER =
  '*ContactName,EmailAddress,InvoiceNumber,*InvoiceDate,DueDate,PaymentTerms,ItemCode,*Description,Quantity,UnitAmount,AccountCode,TaxRate';

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
        l.contact ?? 'Acme Co',
        l.email ?? '',
        l.num ?? '',
        l.date ?? '2026-03-10',
        l.due ?? '2026-04-09',
        l.terms ?? '',
        l.item ?? '',
        l.desc ?? 'Work',
        l.qty ?? '1',
        l.price ?? '100.00',
        l.acct ?? '4100',
        l.tax ?? '',
      ].join(','),
    ),
  ].join('\n');
}

async function stage(agent: Agent, content: string, extra: Record<string, unknown> = {}, kind = 'INVOICES') {
  return agent.post(IMPORTS).send({ kind, fileName: 'invoices.csv', content, ...extra });
}

async function stageOk(content: string, extra: Record<string, unknown> = {}, agent: Agent = agentA): Promise<string> {
  const res = await stage(agent, content, extra);
  if (res.status !== 201) throw new Error(`fixture: stage failed ${String(res.status)} ${res.text}`);
  return res.body.import.id as string;
}

async function getRows(id: string, agent: Agent = agentA): Promise<Row[]> {
  const res = await agent.get(`${IMPORTS}/${id}/rows`);
  expect(res.status).toBe(200);
  return res.body.rows as Row[];
}

async function validate(id: string, agent: Agent = agentA) {
  const res = await agent.post(`${IMPORTS}/${id}/validate`);
  expect(res.status).toBe(200);
  return res;
}

async function stageValidated(content: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = await stageOk(content, extra);
  await validate(id);
  return id;
}

async function listInvoices(agent: Agent = agentA) {
  const res = await agent.get('/api/v1/invoices?limit=100');
  expect(res.status).toBe(200);
  return res.body.invoices as { id: string; invoiceNumber: string | null; status: string; totalCents: number }[];
}

async function periodIdFor(startsOn: string): Promise<string> {
  const p = periods.find((x) => x.startsOn === startsOn);
  if (p === undefined) throw new Error(`fixture: no period ${startsOn}`);
  return p.id;
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
  it('rows sharing an InvoiceNumber stage as one invoice with item defaults applied', async () => {
    await customer(agentA, 'Acme Co');
    await service(agentA, userA.orgId, 'CONSULT', 15000, 1000);
    const id = await stageValidated(
      csv(
        { num: 'INV-100', qty: '2', price: '100.00', desc: 'Explicit line' },
        { num: 'INV-100', item: 'CONSULT', desc: '', price: '', acct: '', qty: '' },
      ),
    );

    const rows = await getRows(id);
    expect(rows.map((r) => r.errors)).toEqual([[], []]);
    expect(rows.map((r) => r.status)).toEqual(['VALID', 'VALID']);
    expect(new Set(rows.map((r) => r.groupKey)).size).toBe(1);

    const preview = await agentA.get(`${IMPORTS}/${id}/preview`);
    expect(preview.status).toBe(200);
    const summary = preview.body.preview.summary as { label: string; value: number }[];
    expect(summary.find((s) => s.label === 'Invoices')?.value).toBe(1);
    expect(summary.find((s) => s.label === 'Lines')?.value).toBe(2);
    // 2 x 100.00 + 1 x 150.00 + 10% tax on the second line (15.00)
    expect(summary.find((s) => s.label === 'Total (base-currency documents)')?.value).toBe(36500);
  });

  it('a blank InvoiceNumber makes each row its own invoice', async () => {
    await customer(agentA, 'Acme Co');
    const id = await stageValidated(csv({ desc: 'One' }, { desc: 'Two' }, { desc: 'Three' }));

    const rows = await getRows(id);
    expect(rows.every((r) => r.errors.length === 0)).toBe(true);
    const preview = await agentA.get(`${IMPORTS}/${id}/preview`);
    const summary = preview.body.preview.summary as { label: string; value: number }[];
    expect(summary.find((s) => s.label === 'Invoices')?.value).toBe(3);
    expect(summary.find((s) => s.label === 'Lines')?.value).toBe(3);
  });

  it('unknown customer, duplicate-name customer, and email disambiguation', async () => {
    await customer(agentA, 'Twin Co', 'one@twin.test');
    await customer(agentA, 'Twin Co', 'two@twin.test');
    const id = await stageValidated(
      csv(
        { contact: 'Nobody Ltd' },
        { contact: 'Twin Co' },
        { contact: 'Twin Co', email: 'two@twin.test' },
        { contact: 'Twin Co', email: 'zzz@twin.test' },
      ),
    );

    const rows = await getRows(id);
    expect(rows[0]?.errors).toContain('Customer "Nobody Ltd" not found — import customers first (Customers → Import)');
    expect(rows[1]?.errors).toContain('"Twin Co" matches 2 customers — add EmailAddress to choose one');
    expect(rows[2]?.errors).toEqual([]);
    expect(rows[2]?.status).toBe('VALID');
    expect(rows[3]?.errors).toContain('Customer "Twin Co" with email zzz@twin.test not found');
  });

  it("header fields must agree across an invoice's rows", async () => {
    await customer(agentA, 'Acme Co');
    const id = await stageValidated(
      csv(
        { num: 'INV-1' },
        { num: 'INV-1' },
        { num: 'INV-1', date: '2026-03-11' },
      ),
    );

    const rows = await getRows(id);
    expect(rows[0]?.errors).toEqual([]);
    expect(rows[1]?.errors).toEqual([]);
    expect(rows[2]?.errors).toContain('Date differs from row 2 ("2026-03-10") — every line of the invoice INV-1 must match');
    expect(rows.map((r) => r.status)).toEqual(['VALID', 'VALID', 'INVALID']);
  });

  it('an existing invoice number is refused', async () => {
    await customer(agentA, 'Acme Co');
    const first = await stageValidated(csv({ num: 'INV-9001' }));
    expect((await agentA.post(`${IMPORTS}/${first}/commit`).send({})).status).toBe(200);

    const second = await stageValidated(csv({ num: 'INV-9001' }));

    const rows = await getRows(second);
    expect(rows[0]?.status).toBe('INVALID');
    expect(rows[0]?.errors).toContain('Invoice number INV-9001 already exists');
  });

  it('missing DueDate and PaymentTerms is an error; PaymentTerms by name resolves', async () => {
    await customer(agentA, 'Acme Co');
    const bad = await stageValidated(csv({ due: '' }));
    expect((await getRows(bad))[0]?.errors).toContain('Enter a DueDate or PaymentTerms');

    const ok = await stageValidated(csv({ due: '', terms: 'Net 30', date: '2026-03-10' }));
    const rows = await getRows(ok);
    expect(rows[0]?.errors).toEqual([]);

    const commit = await agentA.post(`${IMPORTS}/${ok}/commit`).send({});
    expect(commit.status).toBe(200);
    const [inv] = await listInvoices();
    const detail = await agentA.get(`/api/v1/invoices/${inv?.id as string}`);
    expect(detail.body.invoice.dueDate).toBe('2026-04-09');
    expect(detail.body.invoice.paymentTermsCode).toBe('NET_30');
  });
});

describe('commit: drafts and posting', () => {
  it("import as drafts keeps the file's number on the draft", async () => {
    await customer(agentA, 'Acme Co');
    const id = await stageValidated(csv({ num: 'INV-9001' }));

    const commit = await agentA.post(`${IMPORTS}/${id}/commit`).send({ mode: 'DRAFT' });

    expect(commit.status).toBe(200);
    expect(commit.body.result).toEqual({ kind: 'INVOICES', documentCount: 1, lineCount: 1, mode: 'DRAFT' });
    const [inv] = await listInvoices();
    const detail = await agentA.get(`/api/v1/invoices/${inv?.id as string}`);
    expect(detail.status).toBe(200);
    expect(detail.body.invoice.status).toBe('DRAFT');
    expect(detail.body.invoice.invoiceNumber).toBe('INV-9001');
    expect(detail.body.invoice.journalEntryId).toBeNull();
  });

  it('a reserved number survives a later manual issue of that draft', async () => {
    await customer(agentA, 'Acme Co');
    const id = await stageValidated(csv({ num: 'INV-9001' }));
    expect((await agentA.post(`${IMPORTS}/${id}/commit`).send({})).status).toBe(200);
    const [inv] = await listInvoices();

    const issued = await agentA.post(`/api/v1/invoices/${inv?.id as string}/issue`).send({});

    expect(issued.status).toBe(200);
    expect(issued.body.invoice.status).toBe('ISSUED');
    expect(issued.body.invoice.invoiceNumber).toBe('INV-9001');
  });

  it('the sequence skips imported numbers', async () => {
    const customerId = await customer(agentA, 'Acme Co');
    const set = await agentA.patch('/api/v1/settings/invoicing').send({ numberPrefix: 'INV-', numberPadding: 6, nextNumber: 1 });
    expect(set.status).toBe(200);

    const id = await stageValidated(csv({ num: 'INV-000005' }));
    expect((await agentA.post(`${IMPORTS}/${id}/commit`).send({ mode: 'POST' })).status).toBe(200);

    const created = await agentA.post('/api/v1/invoices').send({
      customerId,
      issueDate: '2026-03-12',
      dueDate: '2026-04-12',
      lines: [
        { description: 'Normal', quantityMilli: 1000, unitPriceCents: 5000, revenueAccountId: await accountId(userA.orgId, '4100'), taxRateBp: 0 },
      ],
    });
    expect(created.status).toBe(201);
    const issued = await agentA.post(`/api/v1/invoices/${created.body.invoice.id as string}/issue`).send({});
    expect(issued.status).toBe(200);
    expect(issued.body.invoice.invoiceNumber).toBe('INV-000006');
  });

  it("import and post issues every invoice with the file's numbers", async () => {
    await customer(agentA, 'Acme Co');
    const id = await stageValidated(
      csv({ num: 'INV-7001', price: '100.00' }, { num: 'INV-7001', price: '50.00' }, { num: 'INV-7002', price: '200.00' }),
    );

    const commit = await agentA.post(`${IMPORTS}/${id}/commit`).send({ mode: 'POST' });

    expect(commit.status).toBe(200);
    expect(commit.body.result).toEqual({ kind: 'INVOICES', documentCount: 2, lineCount: 3, mode: 'POST' });
    const invoices = await listInvoices();
    expect(invoices.map((i) => i.status)).toEqual(['ISSUED', 'ISSUED']);
    expect(invoices.map((i) => i.invoiceNumber).sort()).toEqual(['INV-7001', 'INV-7002']);

    const aging = await agentA.get('/api/v1/reports/ar-aging?asOf=2026-03-31');
    expect(aging.body.totalOutstandingCents).toBe(35000);
    expect(aging.body.reconciles).toBe(true);
    const tb = await agentA.get('/api/v1/reports/trial-balance');
    expect(tb.body.isBalanced).toBe(true);
  });

  it('post with a posting date in a closed period: preview blocks, commit rolls back everything', async () => {
    await customer(agentA, 'Acme Co');
    const id = await stageValidated(csv({ num: 'INV-8001' }, { num: 'INV-8002', date: '2026-04-05', due: '2026-05-05' }));
    const close = await agentA.post(`${PERIODS}/${await periodIdFor('2026-03-01')}/close`);
    expect(close.status).toBe(200);

    const preview = await agentA.get(`${IMPORTS}/${id}/preview?mode=POST&postingDate=2026-03-15`);
    expect(preview.status).toBe(200);
    expect(preview.body.preview.canCommit).toBe(false);
    const warnings = preview.body.preview.warnings as string[];
    expect(warnings.some((w) => w.includes('the period covering 2026-03-15 is CLOSED'))).toBe(true);

    const commit = await agentA.post(`${IMPORTS}/${id}/commit`).send({ mode: 'POST', postingDate: '2026-03-15' });

    expect([409, 422]).toContain(commit.status);
    expect(await listInvoices()).toEqual([]);
    const after = await agentA.get(`${IMPORTS}/${id}`);
    expect(after.body.import.status).toBe('VALIDATED');
  });
});

describe('conversion mode', () => {
  it('conversion mode posts to 3400 on the conversion date and nets the opening plug', async () => {
    await customer(agentA, 'Acme Co');
    const opening = await agentA.post(IMPORTS).send({
      kind: 'OPENING_BALANCES',
      fileName: 'tb.csv',
      content: ['Code,Debit,Credit', '1110,1000.00,', '3100,,1000.00'].join('\n'),
    });
    expect(opening.status).toBe(201);
    expect((await agentA.post(`${IMPORTS}/${opening.body.import.id as string}/commit`).send({})).status).toBe(200);

    const id = await stageValidated(
      csv({ num: 'OLD-1', date: '2025-12-22', due: '2026-01-21', price: '500.00', acct: '', desc: 'Carried over' }),
      { conversionMode: true },
    );
    const staged = await agentA.get(`${IMPORTS}/${id}`);
    expect(staged.body.import.conversionMode).toBe(true);

    const commit = await agentA.post(`${IMPORTS}/${id}/commit`).send({});

    expect(commit.status).toBe(200);
    expect(commit.body.result).toEqual({ kind: 'INVOICES', documentCount: 1, lineCount: 1, mode: 'POST' });
    const [inv] = await listInvoices();
    const detail = await agentA.get(`/api/v1/invoices/${inv?.id as string}`);
    expect(detail.body.invoice.status).toBe('ISSUED');
    expect(detail.body.invoice.invoiceNumber).toBe('OLD-1');
    expect(detail.body.invoice.issueDate).toBe('2025-12-22');
    expect(detail.body.invoice.dueDate).toBe('2026-01-21');

    const entry = await agentA.get(`/api/v1/journals/${detail.body.invoice.journalEntryId as string}`);
    expect(entry.body.entry.entryDate).toBe('2026-01-01');

    // Ageing keeps the document's own due date: 20 days overdue on 2026-02-10.
    const aging = await agentA.get('/api/v1/reports/ar-aging?asOf=2026-02-10');
    expect(aging.body.totalOutstandingCents).toBe(50000);
    expect(aging.body.rows[0].d1to30Cents).toBe(50000);
    expect(aging.body.reconciles).toBe(true);

    const pnl = await agentA.get('/api/v1/reports/profit-and-loss?from=2026-01-01&to=2026-12-31');
    expect(pnl.body.revenue.totalCents).toBe(0);
    expect(await net3400(userA.orgId)).toBe(50000);
  });

  it('conversion mode rules: ItemCode, non-zero tax, and dates after the conversion date are refused', async () => {
    await customer(agentA, 'Acme Co');
    await service(agentA, userA.orgId, 'CONSULT', 15000, 0);
    const id = await stageValidated(
      csv(
        { date: '2025-12-20', item: 'CONSULT' },
        { date: '2025-12-20', tax: '10' },
        { date: '2026-02-01', due: '2026-03-01' },
      ),
      { conversionMode: true },
    );

    const rows = await getRows(id);
    expect(rows[0]?.errors).toContain('Conversion mode imports balances, not products — leave ItemCode blank');
    expect(rows[1]?.errors).toContain('Tax must be 0 in conversion mode — import the amount outstanding including tax');
    expect(rows[2]?.errors).toContain(
      'In conversion mode the date must be on or before your conversion date (2026-01-01)',
    );
    expect(rows.every((r) => r.status === 'INVALID')).toBe(true);
  });

  it('conversion mode refuses mode DRAFT and an explicit posting date with 400', async () => {
    await customer(agentA, 'Acme Co');
    const id = await stageValidated(csv({ date: '2025-12-20' }), { conversionMode: true });

    const draft = await agentA.post(`${IMPORTS}/${id}/commit`).send({ mode: 'DRAFT' });
    expect(draft.status).toBe(400);
    expect(draft.body.error).toBe('Conversion-mode imports are always posted');

    const dated = await agentA.post(`${IMPORTS}/${id}/commit`).send({ postingDate: '2026-01-01' });
    expect(dated.status).toBe(400);
    expect(dated.body.error).toBe('Conversion-mode imports post on your conversion date');
    expect(await listInvoices()).toEqual([]);
  });

  it('conversionMode on a non-document kind is 400', async () => {
    const res = await stage(agentA, 'Name\nAcme Co', { conversionMode: true }, 'CUSTOMERS');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('conversionMode applies only to invoice and bill imports');
  });
});

describe('roles and tenant isolation', () => {
  it('an ACCOUNTANT cannot commit', async () => {
    await customer(agentA, 'Acme Co');
    const id = await stageValidated(csv({ num: 'INV-1' }));
    const accountant = await createUserWithOrg({ label: 'invimp-acct' });
    await addMember(userA.orgId, accountant.id, 'ACCOUNTANT');
    const agent = await loginAgent(app, accountant);
    const switched = await agent.post('/api/v1/auth/switch-org').send({ orgId: userA.orgId });
    expect(switched.body.role).toBe('ACCOUNTANT');

    const commit = await agent.post(`${IMPORTS}/${id}/commit`).send({ mode: 'POST' });

    expect(commit.status).toBe(403);
    expect(await listInvoices()).toEqual([]);
  });

  it("cross-tenant: org B's customers and items don't resolve; org B cannot read or commit org A's import", async () => {
    await customer(agentA, 'Alpha Only');
    await customer(agentB, 'Bravo Only');
    await service(agentA, userA.orgId, 'ALPHA-SVC', 1000, 0);
    await service(agentB, userB.orgId, 'BRAVO-SVC', 1000, 0);

    // Org A refers to org B's customer and item, and org B to org A's.
    const idA = await stageValidated(csv({ contact: 'Bravo Only', item: 'BRAVO-SVC', num: 'X-1' }));
    const rowsA = await getRows(idA);
    expect(rowsA[0]?.status).toBe('INVALID');
    expect(rowsA[0]?.errors).toContain('Customer "Bravo Only" not found — import customers first (Customers → Import)');
    expect(rowsA[0]?.errors).toContain('Item "BRAVO-SVC" was not found');

    const idB = await stageOk(csv({ contact: 'Alpha Only', item: 'ALPHA-SVC', num: 'X-1' }), {}, agentB);
    await validate(idB, agentB);
    const rowsB = await getRows(idB, agentB);
    expect(rowsB[0]?.errors).toContain('Customer "Alpha Only" not found — import customers first (Customers → Import)');
    expect(rowsB[0]?.errors).toContain('Item "ALPHA-SVC" was not found');

    // A valid org A import is invisible to org B.
    const idGood = await stageValidated(csv({ contact: 'Alpha Only', num: 'A-1' }));
    expect((await agentB.get(`${IMPORTS}/${idGood}`)).status).toBe(404);
    expect((await agentB.get(`${IMPORTS}/${idGood}/preview`)).status).toBe(404);
    expect((await agentB.post(`${IMPORTS}/${idGood}/commit`).send({ mode: 'POST' })).status).toBe(404);
    expect(await listInvoices(agentA)).toEqual([]);
    expect(await listInvoices(agentB)).toEqual([]);

    // Invoice numbers are per org: B may use A's number.
    const idB2 = await stageOk(csv({ contact: 'Bravo Only', num: 'A-1' }), {}, agentB);
    await validate(idB2, agentB);
    expect((await getRows(idB2, agentB))[0]?.errors).toEqual([]);
  });
});
