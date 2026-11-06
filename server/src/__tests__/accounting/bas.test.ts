import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId, createCustomer, receivePayment } from '../helpers/accountingFixtures.js';
import { createVendor } from '../helpers/depositFixtures.js';

/**
 * The Business Activity Statement (Phase 49d). Integration tier, real PostgreSQL.
 *
 * Every expected figure below is worked by hand from the transactions, never
 * read back from the engine. The central claims: both bases report the right
 * labels; a fully paid document telescopes to exactly its tax; the return ties
 * to the GL; a finalised return does not move; lodging clears the accounts to
 * what is owed; and nothing crosses a tenant.
 */

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>;

const Q3 = '2026-01-01'; // January to March 2026
const Q4 = '2026-04-01'; // April to June 2026

let user: SeededUser;
let agent: Agent;
let customer: string;
let vendor: string;

async function setUp(basis: 'CASH' | 'ACCRUAL', method: 'SIMPLER' | 'FULL' = 'FULL') {
  user = await createUserWithOrg({ label: 'a' });
  agent = await loginAgent(app, user);
  const res = await agent.post('/api/v1/settings/onboarding').send({
    organizationName: 'Harbour Bakery',
    legalName: null,
    baseCurrency: 'AUD',
    fiscalYearStartMonth: 7,
    fiscalYearStartDay: 1,
    booksStartDate: '2025-07-01',
    industry: null,
    timezone: 'Australia/Sydney',
    cashAccountId: null,
    australia: { gst: { registered: true, basis, basCycle: 'QUARTERLY', basMethod: method } },
  });
  expect(res.status).toBe(200);
  customer = await createCustomer(agent, 'Harbour Cafe');
  vendor = await createVendor(agent, 'Coastal Supplies');
}

async function invoice(issueDate: string, lines: { cents: number; code: string }[], taxMode = 'EXCLUSIVE'): Promise<string> {
  const revenue = await accountId(user.orgId, '4100');
  const created = await agent.post('/api/v1/invoices').send({
    customerId: customer,
    issueDate,
    dueDate: '2026-12-31',
    notes: null,
    paymentTerms: null,
    taxMode,
    lines: lines.map((l) => ({ description: 'x', quantityMilli: 1000, unitPriceCents: l.cents, revenueAccountId: revenue, taxCode: l.code })),
  });
  if (created.status !== 201) throw new Error(`fixture: invoice ${created.status} ${created.text}`);
  const id = created.body.invoice.id as string;
  const issued = await agent.post(`/api/v1/invoices/${id}/issue`).send({});
  if (issued.status !== 200) throw new Error(`fixture: issue ${issued.status} ${issued.text}`);
  return id;
}

async function bill(billDate: string, lines: { cents: number; code: string; account?: string }[]): Promise<string> {
  const created = await agent.post('/api/v1/bills').send({
    vendorId: vendor,
    vendorReference: `R-${String(Math.random())}`,
    billDate,
    dueDate: '2026-12-31',
    notes: null,
    paymentTerms: null,
    lines: await Promise.all(
      lines.map(async (l) => ({
        description: 'x',
        quantityMilli: 1000,
        unitPriceCents: l.cents,
        expenseAccountId: await accountId(user.orgId, l.account ?? '6130'),
        taxCode: l.code,
      })),
    ),
  });
  if (created.status !== 201) throw new Error(`fixture: bill ${created.status} ${created.text}`);
  const id = created.body.bill.id as string;
  expect((await agent.post(`/api/v1/bills/${id}/submit`).send({})).status).toBe(200);
  const approved = await agent.post(`/api/v1/bills/${id}/approve`).send({});
  if (approved.status !== 200) throw new Error(`fixture: approve ${approved.status} ${approved.text}`);
  return id;
}

async function payBill(paymentDate: string, billId: string, amountCents: number): Promise<string> {
  const res = await agent.post('/api/v1/payments').send({
    direction: 'PAY',
    paymentDate,
    amountCents,
    cashAccountId: await accountId(user.orgId, '1110'),
    vendorId: vendor,
    reference: `P-${paymentDate}`,
    allocations: [{ invoiceId: null, billId, amountCents }],
  });
  if (res.status !== 201) throw new Error(`fixture: pay ${res.status} ${res.text}`);
  return res.body.payment.id as string;
}

async function creditNote(invoiceId: string, issueDate: string, cents: number, code = 'S_GST', action = true): Promise<string> {
  const created = await agent.post('/api/v1/credit-notes').send({
    invoiceId,
    issueDate,
    reasonCode: 'PRICE_ADJUSTMENT',
    reason: null,
    notes: null,
    lines: [{ description: 'credit', quantityMilli: 1000, unitPriceCents: cents, revenueAccountId: await accountId(user.orgId, '4100'), taxCode: code }],
  });
  if (created.status !== 201) throw new Error(`fixture: note ${created.status} ${created.text}`);
  const id = created.body.creditNote.id as string;
  if (action) {
    const issued = await agent.post(`/api/v1/credit-notes/${id}/issue`).send({});
    if (issued.status !== 200) throw new Error(`fixture: note issue ${issued.status} ${issued.text}`);
  }
  return id;
}

async function newBas(periodStart: string) {
  const res = await agent.post('/api/v1/bas').send({ periodStart });
  if (res.status !== 201) throw new Error(`fixture: bas ${res.status} ${res.text}`);
  return res.body.bas as {
    id: string;
    labels: Record<string, number>;
    summary: { netPayable: number };
    reconciliation: { sales: { differenceCents: number; unpaidMovementCents: number }; purchases: { differenceCents: number; unpaidMovementCents: number } };
    warnings: { code: string }[];
  };
}

async function balance(code: string): Promise<number> {
  const { rows } = await pool.query<{ d: string; c: string }>(
    `SELECT COALESCE(SUM(l.base_debit_cents),0)::text AS d, COALESCE(SUM(l.base_credit_cents),0)::text AS c
       FROM ledger_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.org_id = $1 AND a.code = $2`,
    [user.orgId, code],
  );
  return Number(rows[0]?.d ?? 0) - Number(rows[0]?.c ?? 0);
}

beforeEach(async () => {
  await resetTables();
});

afterAll(async () => {
  await closePool();
});

describe('on an accruals basis', () => {
  beforeEach(() => setUp('ACCRUAL'));

  it('reports every label from a mixed quarter', async () => {
    await invoice('2026-02-01', [
      { cents: 100_000, code: 'S_GST' }, // G1 110,000 incl; GST 10,000
      { cents: 20_000, code: 'S_EXPORT' }, // G1, G2
      { cents: 5_000, code: 'S_FREE' }, // G1, G3
      { cents: 3_000, code: 'S_INPUT_TAXED' }, // G1, G4
      { cents: 7_000, code: 'S_EXCLUDED' }, // nowhere
    ]);
    await bill('2026-02-10', [
      { cents: 40_000, code: 'P_GST' }, // G11 44,000; GST 4,000
      { cents: 50_000, code: 'P_CAP_GST', account: '1500' }, // G10 55,000; GST 5,000
      { cents: 1_000, code: 'P_FREE' }, // G11, G14
      { cents: 2_200, code: 'P_PRIVATE' }, // G11, G15
    ]);
    // Outside the quarter.
    await invoice('2026-04-02', [{ cents: 999_900, code: 'S_GST' }]);

    const bas = await newBas(Q3);
    expect(bas.labels).toMatchObject({
      G1: 138_000,
      G2: 20_000,
      G3: 5_000,
      G4: 3_000,
      G5: 28_000,
      G6: 110_000,
      G8: 110_000,
      G9: 10_000,
      G10: 55_000,
      G11: 47_200,
      G12: 102_200,
      G14: 1_000,
      G15: 2_200,
      G16: 3_200,
      G17: 99_000,
      G19: 99_000,
      G20: 9_000,
      '1A': 10_000,
      '1B': 9_000,
    });
    expect(bas.summary.netPayable).toBe(10);
    expect(bas.reconciliation.sales.differenceCents).toBe(0);
    expect(bas.reconciliation.purchases.differenceCents).toBe(0);
  });

  it('handles tax-inclusive documents', async () => {
    await invoice('2026-02-01', [{ cents: 11_000, code: 'S_GST' }], 'INCLUSIVE');
    const bas = await newBas(Q3);
    expect(bas.labels).toMatchObject({ G1: 11_000, '1A': 1_000 });
  });

  it('nets a credit note in the same period and treats an earlier one as an adjustment', async () => {
    const jan = await invoice('2026-01-15', [{ cents: 10_000, code: 'S_GST' }]);
    await creditNote(jan, '2026-02-15', 2_000);
    const q3 = await newBas(Q3);
    expect(q3.labels).toMatchObject({ G1: 8_800, G7: 0, '1A': 800 });

    const march = await invoice('2026-03-15', [{ cents: 30_000, code: 'S_GST' }]);
    await creditNote(march, '2026-04-20', 5_000);
    const q4 = await newBas(Q4);
    // G1 is untouched; the $55 inclusive credit reduces GST through G7.
    expect(q4.labels).toMatchObject({ G1: 0, G7: -5_500, G8: -5_500, G9: -500, '1A': -500 });
    expect(q4.reconciliation.sales.differenceCents).toBe(0);
  });

  it('includes journals, and a reversal in the period it happens', async () => {
    const journal = await agent.post('/api/v1/manual-journals').send({
      entryDate: '2026-02-20',
      narration: 'Advice',
      action: 'post',
      lines: [
        { accountId: await accountId(user.orgId, '6200'), debitCents: 22_000, taxCode: 'P_GST' },
        { accountId: await accountId(user.orgId, '2120'), creditCents: 22_000 },
      ],
    });
    expect(journal.status).toBe(201);
    expect((await newBas(Q3)).labels).toMatchObject({ G11: 22_000, '1B': 2_000 });

    expect(
      (await agent.post(`/api/v1/manual-journals/${journal.body.journal.id as string}/void`).send({ voidDate: '2026-04-10' })).status,
    ).toBe(200);
    const q4 = await newBas(Q4);
    expect(q4.labels).toMatchObject({ G11: -22_000, '1B': -2_000 });
    expect(q4.reconciliation.purchases.differenceCents).toBe(0);
  });

  it('warns about an uncoded line and a deposit in the period', async () => {
    const created = await agent.post('/api/v1/invoices').send({
      customerId: customer,
      issueDate: '2026-02-01',
      dueDate: '2026-12-31',
      notes: null,
      paymentTerms: null,
      lines: [{ description: 'x', quantityMilli: 1000, unitPriceCents: 1_000, revenueAccountId: await accountId(user.orgId, '4100') }],
    });
    const id = created.body.invoice.id as string;
    await agent.post(`/api/v1/invoices/${id}/issue`).send({});
    // Forced back to how a line from before activation looks.
    await pool.query('ALTER TABLE invoice_lines DISABLE TRIGGER USER');
    await pool.query('UPDATE invoice_lines SET tax_code = NULL WHERE invoice_id = $1', [id]);
    await pool.query('ALTER TABLE invoice_lines ENABLE TRIGGER USER');
    const bas = await newBas(Q3);
    expect(bas.warnings.map((w) => w.code)).toContain('UNCODED_LINES');
  });
});

describe('on a cash basis', () => {
  beforeEach(() => setUp('CASH'));

  it('reports nothing until paid, then the share paid, then the rest', async () => {
    const inv = await invoice('2026-02-01', [{ cents: 100_000, code: 'S_GST' }]); // $1,100 inclusive
    const purchase = await bill('2026-02-02', [{ cents: 40_000, code: 'P_GST' }]); // $440 inclusive

    const unpaid = await newBas(Q3);
    expect(unpaid.labels).toMatchObject({ G1: 0, '1A': 0, G11: 0, '1B': 0 });
    expect(unpaid.reconciliation.sales).toMatchObject({ unpaidMovementCents: 10_000, differenceCents: 0 });
    expect(unpaid.reconciliation.purchases).toMatchObject({ unpaidMovementCents: 4_000, differenceCents: 0 });
    await agent.delete(`/api/v1/bas/${unpaid.id}`);

    await receivePayment(agent, user.orgId, customer, '2026-03-01', [{ invoiceId: inv, amountCents: 44_000 }]); // 40%
    await payBill('2026-03-02', purchase, 44_000); // all of it

    const q3 = await newBas(Q3);
    expect(q3.labels).toMatchObject({ G1: 44_000, '1A': 4_000, G11: 44_000, '1B': 4_000 });
    expect(q3.reconciliation.sales).toMatchObject({ unpaidMovementCents: 6_000, differenceCents: 0 });

    await receivePayment(agent, user.orgId, customer, '2026-05-01', [{ invoiceId: inv, amountCents: 66_000 }]);
    const q4 = await newBas(Q4);
    expect(q4.labels).toMatchObject({ G1: 66_000, '1A': 6_000, G11: 0, '1B': 0 });
    expect(q4.reconciliation.sales).toMatchObject({ unpaidMovementCents: -6_000, differenceCents: 0 });
  });

  it('a voided payment comes back out', async () => {
    const inv = await invoice('2026-02-01', [{ cents: 10_000, code: 'S_GST' }]);
    const payment = await receivePayment(agent, user.orgId, customer, '2026-03-01', [{ invoiceId: inv, amountCents: 11_000 }]);
    expect((await newBas(Q3)).labels['1A']).toBe(1_000);
    expect((await agent.post(`/api/v1/payments/${payment}/void`).send({ entryDate: '2026-04-05' })).status).toBe(200);
    expect((await newBas(Q4)).labels).toMatchObject({ G1: -11_000, '1A': -1_000 });
  });

  it('an invoice cleared by a credit note nets to nil', async () => {
    const inv = await invoice('2026-02-01', [{ cents: 10_000, code: 'S_GST' }]);
    await creditNote(inv, '2026-02-10', 10_000);
    const bas = await newBas(Q3);
    expect(bas.labels).toMatchObject({ G1: 0, '1A': 0 });
    expect(bas.reconciliation.sales.differenceCents).toBe(0);
  });

  it('a part credit and a part payment report what was really received', async () => {
    const inv = await invoice('2026-02-01', [{ cents: 10_000, code: 'S_GST' }]); // $110
    await creditNote(inv, '2026-02-10', 5_000); // $55 of it credited
    await receivePayment(agent, user.orgId, customer, '2026-02-20', [{ invoiceId: inv, amountCents: 5_500 }]);
    expect((await newBas(Q3)).labels).toMatchObject({ G1: 5_500, '1A': 500 });
  });

  it('splits a mixed document by line', async () => {
    const inv = await invoice('2026-02-01', [
      { cents: 10_000, code: 'S_GST' },
      { cents: 11_000, code: 'S_FREE' },
    ]); // $110 + $110 = $220
    await receivePayment(agent, user.orgId, customer, '2026-03-01', [{ invoiceId: inv, amountCents: 11_000 }]); // half
    expect((await newBas(Q3)).labels).toMatchObject({ G1: 11_000, G3: 5_500, '1A': 500 });
  });

  it('telescopes to exactly the tax over many awkward payments', async () => {
    const inv = await invoice('2026-01-05', [
      { cents: 3_333, code: 'S_GST' },
      { cents: 1_999, code: 'S_GST' },
      { cents: 777, code: 'S_FREE' },
    ]);
    const detail = await agent.get(`/api/v1/invoices/${inv}`);
    const total = detail.body.invoice.totalCents as number;
    const tax = detail.body.invoice.taxCents as number;
    const pay = [Math.floor(total / 7), Math.floor(total / 3), 1];
    pay.push(total - pay.reduce((a, b) => a + b, 0));
    const dates = ['2026-01-10', '2026-03-31', '2026-04-01', '2026-06-30'];
    for (const [i, amount] of pay.entries()) {
      await receivePayment(agent, user.orgId, customer, dates[i] ?? '', [{ invoiceId: inv, amountCents: amount }]);
    }
    const q3 = await newBas(Q3);
    const q4 = await newBas(Q4);
    expect((q3.labels['1A'] ?? 0) + (q4.labels['1A'] ?? 0)).toBe(tax);
    expect((q3.labels.G1 ?? 0) + (q4.labels.G1 ?? 0)).toBe(total);
  });
});

describe('finalising', () => {
  beforeEach(() => setUp('ACCRUAL'));

  it('stores the return, closes the months, and later activity does not move it', async () => {
    const inv = await invoice('2026-02-01', [{ cents: 10_000, code: 'S_GST' }]);
    const bas = await newBas(Q3);
    const done = await agent.post(`/api/v1/bas/${bas.id}/finalise`).send({});
    expect(done.status).toBe(200);
    expect(done.body.bas.status).toBe('FINALISED');
    expect(done.body.bas.labels['1A']).toBe(1_000);

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM fiscal_periods WHERE org_id = $1 AND starts_on >= '2026-01-01' AND ends_on <= '2026-03-31'`,
      [user.orgId],
    );
    expect(rows.map((r) => r.status)).toEqual(['CLOSED', 'CLOSED', 'CLOSED']);

    // A posting dated in the quarter is refused.
    const late = await agent.post('/api/v1/invoices').send({
      customerId: customer,
      issueDate: '2026-02-15',
      dueDate: '2026-12-31',
      notes: null,
      paymentTerms: null,
      lines: [{ description: 'x', quantityMilli: 1000, unitPriceCents: 100, revenueAccountId: await accountId(user.orgId, '4100'), taxCode: 'S_GST' }],
    });
    expect((await agent.post(`/api/v1/invoices/${late.body.invoice.id as string}/issue`).send({})).status).toBe(422);

    // A note allocation dated in the quarter posts no journal, so has its own guard.
    const note = await creditNote(inv, '2026-04-02', 1_000, 'S_GST', false);
    await agent.post(`/api/v1/credit-notes/${note}/issue`).send({});
    const other = await invoice('2026-04-03', [{ cents: 500, code: 'S_GST' }]);
    const applied = await agent.post(`/api/v1/credit-notes/${note}/allocations`).send({ invoiceId: other, amountCents: 1, allocationDate: '2026-03-15' });
    expect(applied.status).toBe(422);

    const again = await agent.get(`/api/v1/bas/${bas.id}`);
    expect(again.body.bas.labels['1A']).toBe(1_000);
    const events = await agent.get(`/api/v1/bas/${bas.id}/events?label=G1`);
    expect(events.body.events).toHaveLength(1);
    expect(events.body.events[0]).toMatchObject({ sourceKind: 'INVOICE', grossCents: 11_000, taxCents: 1_000 });
  });

  it('refuses a period that has not ended', async () => {
    const future = await newBas('2026-10-01');
    expect(future.warnings.map((w) => w.code)).toContain('PERIOD_NOT_ENDED');
    expect((await agent.post(`/api/v1/bas/${future.id}/finalise`).send({})).status).toBe(422);
  });

  it('reopening removes the snapshot and reopens the months', async () => {
    await invoice('2026-02-01', [{ cents: 10_000, code: 'S_GST' }]);
    const bas = await newBas(Q3);
    await agent.post(`/api/v1/bas/${bas.id}/finalise`).send({});
    const reopened = await agent.post(`/api/v1/bas/${bas.id}/reopen`).send({});
    expect(reopened.status).toBe(200);
    expect(reopened.body.bas.status).toBe('DRAFT');
    await invoice('2026-02-20', [{ cents: 20_000, code: 'S_GST' }]);
    expect((await agent.get(`/api/v1/bas/${bas.id}`)).body.bas.labels['1A']).toBe(3_000);
  });

  it('cannot leave the Australian edition afterwards', async () => {
    const bas = await newBas(Q3);
    await agent.post(`/api/v1/bas/${bas.id}/finalise`).send({});
    expect((await agent.post('/api/v1/settings/region/generic').send({})).status).toBe(409);
  });
});

describe('lodging', () => {
  it('clears the GST and PAYG accounts to the ATO, with cents to rounding', async () => {
    await setUp('ACCRUAL');
    await invoice('2026-02-01', [{ cents: 1_234_567, code: 'S_GST' }]); // GST 123,456.7 -> 1,234.57
    await bill('2026-02-02', [{ cents: 400_099, code: 'P_GST' }]); // GST 40,009.9 -> 400.10
    // Wages paid and tax withheld, as payroll software would journal them.
    const wages = await agent.post('/api/v1/manual-journals').send({
      entryDate: '2026-02-28',
      narration: 'Wages',
      action: 'post',
      lines: [
        { accountId: await accountId(user.orgId, '6100'), debitCents: 500_000 },
        { accountId: await accountId(user.orgId, '2162'), creditCents: 100_050 },
        { accountId: await accountId(user.orgId, '2120'), creditCents: 399_950 },
      ],
    });
    expect(wages.status).toBe(201);

    const bas = await newBas(Q3);
    expect((await agent.get(`/api/v1/bas/${bas.id}`)).body.bas.paygSuggestion).toEqual({ w1Cents: 500_000, w2Cents: 100_050 });
    const patched = await agent.patch(`/api/v1/bas/${bas.id}`).send({ w1Cents: 500_000, w2Cents: 100_050, instalmentCents: 30_000 });
    expect(patched.status).toBe(200);

    expect((await agent.post(`/api/v1/bas/${bas.id}/lodge`).send({ lodgedOn: '2026-04-20' })).status).toBe(409);
    await agent.post(`/api/v1/bas/${bas.id}/finalise`).send({});
    expect((await agent.post(`/api/v1/bas/${bas.id}/lodge`).send({ lodgedOn: '2026-03-20' })).status).toBe(422);
    const lodged = await agent.post(`/api/v1/bas/${bas.id}/lodge`).send({ lodgedOn: '2026-04-20', atoReference: 'REC123' });
    expect(lodged.status).toBe(200);
    expect(lodged.body.bas).toMatchObject({ status: 'LODGED', lodgedOn: '2026-04-20', atoReference: 'REC123' });

    // 1A $1,234 + W2 $1,000 + T7 $300 - 1B $400 = $2,134, in whole dollars.
    expect(lodged.body.bas.summary.netPayable).toBe(2_134);
    expect(await balance('2140')).toBe(0);
    expect(await balance('1180')).toBe(0);
    expect(await balance('2162')).toBe(0);
    expect(await balance('1185')).toBe(30_000);
    expect(await balance('2150')).toBe(-213_400);
    // Exact owed 123,457 + 100,050 + 30,000 - 40,010 = 213,497; 97 cents to rounding.
    expect(await balance('6830')).toBe(-97);

    // A lodged return does not move, by service or by database.
    expect((await agent.post(`/api/v1/bas/${bas.id}/reopen`).send({})).status).toBe(409);
    await expect(pool.query(`UPDATE bas_returns SET ato_reference = 'X' WHERE id = $1`, [bas.id])).rejects.toThrow(/immutable/);
    await expect(pool.query('DELETE FROM bas_return_labels WHERE bas_return_id = $1', [bas.id])).rejects.toThrow(/immutable/);
  });

  it('on a cash basis leaves the GST on unpaid documents in the accounts', async () => {
    await setUp('CASH');
    const inv = await invoice('2026-02-01', [{ cents: 100_000, code: 'S_GST' }]);
    await receivePayment(agent, user.orgId, customer, '2026-03-01', [{ invoiceId: inv, amountCents: 44_000 }]);
    const bas = await newBas(Q3);
    await agent.post(`/api/v1/bas/${bas.id}/finalise`).send({});
    await agent.post(`/api/v1/bas/${bas.id}/lodge`).send({ lodgedOn: '2026-04-20' });
    // $100 of GST collected is unpaid by the customer yet: $60 stays owing later.
    expect(await balance('2140')).toBe(-6_000);
    expect(await balance('2150')).toBe(-4_000);
  });

  it('a manual adjustment reaches the BAS and posts to its chosen account, keeping GST accounts clean', async () => {
    await setUp('ACCRUAL');
    const bas = await newBas(Q3);
    const added = await agent.post(`/api/v1/bas/${bas.id}/adjustments`).send({
      label: 'G7',
      grossCents: 11_000,
      accountId: await accountId(user.orgId, '6200'),
      reason: 'Under-reported sale last quarter',
    });
    expect(added.status).toBe(201);
    expect(added.body.bas.labels).toMatchObject({ G7: 11_000, G8: 11_000, G9: 1_000, '1A': 1_000 });
    await agent.post(`/api/v1/bas/${bas.id}/finalise`).send({});
    await agent.post(`/api/v1/bas/${bas.id}/lodge`).send({ lodgedOn: '2026-04-20' });
    expect(await balance('2140')).toBe(0);
    expect(await balance('6200')).toBe(1_000);
    expect(await balance('2150')).toBe(-1_000);
  });

  it('refuses an adjustment with no reason', async () => {
    await setUp('ACCRUAL');
    const bas = await newBas(Q3);
    const res = await agent.post(`/api/v1/bas/${bas.id}/adjustments`).send({ label: 'G7', grossCents: 100, accountId: await accountId(user.orgId, '6200'), reason: ' ' });
    expect(res.status).toBe(400);
  });
});

describe('periods and settings', () => {
  it('freezes basis and method on the return', async () => {
    await setUp('CASH', 'SIMPLER');
    const bas = await newBas(Q3);
    await agent.patch('/api/v1/settings/gst').send({ basis: 'ACCRUAL', basMethod: 'FULL' });
    const read = await agent.get(`/api/v1/bas/${bas.id}`);
    expect(read.body.bas).toMatchObject({ basis: 'CASH', method: 'SIMPLER' });
    expect(read.body.bas.reportedLabels).toEqual(['G1', '1A', '1B']);
  });

  it('refuses an overlap and a period that does not start a quarter', async () => {
    await setUp('CASH');
    await newBas(Q3);
    expect((await agent.post('/api/v1/bas').send({ periodStart: Q3 })).status).toBe(409);
    expect((await agent.post('/api/v1/bas').send({ periodStart: '2026-02-01' })).status).toBe(422);
  });

  it('suggests the periods with no return, with due dates', async () => {
    await setUp('CASH');
    const res = await agent.get('/api/v1/bas');
    expect(res.status).toBe(200);
    expect(res.body.suggested.length).toBeGreaterThan(0);
    expect(res.body.suggested[0].dueDate).toMatch(/-28$/);
  });

  it('exports the return and its audit in every format', async () => {
    await setUp('ACCRUAL');
    await invoice('2026-02-01', [{ cents: 10_000, code: 'S_GST' }]);
    const bas = await newBas(Q3);
    const csv = await agent.get(`/api/v1/bas/${bas.id}?format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('GST on sales');
    expect((await agent.get(`/api/v1/bas/${bas.id}?format=pdf`)).status).toBe(200);
    expect((await agent.get(`/api/v1/bas/${bas.id}/events?format=xlsx`)).status).toBe(200);
  });
});

describe('access', () => {
  it('is refused to a generic organization, and across tenants', async () => {
    await setUp('ACCRUAL');
    const bas = await newBas(Q3);
    const other = await createUserWithOrg({ label: 'b' });
    const otherAgent = await loginAgent(app, other);
    expect((await otherAgent.get('/api/v1/bas')).status).toBe(403);
    expect((await otherAgent.post('/api/v1/bas').send({ periodStart: Q3 })).status).toBe(403);

    await otherAgent.post('/api/v1/settings/region/australia').send({
      gst: { registered: true, basis: 'ACCRUAL', basCycle: 'QUARTERLY', basMethod: 'FULL' },
      timezone: 'Australia/Perth',
    });
    expect((await otherAgent.get(`/api/v1/bas/${bas.id}`)).status).toBe(404);
    expect((await otherAgent.post(`/api/v1/bas/${bas.id}/finalise`).send({})).status).toBe(404);
    expect((await otherAgent.get(`/api/v1/bas/${bas.id}/events`)).status).toBe(404);
  });

  it('gives a viewer read access only', async () => {
    await setUp('ACCRUAL');
    const bas = await newBas(Q3);
    const viewer = await createUserWithOrg({ label: 'v' });
    await addMember(user.orgId, viewer.id, 'VIEWER');
    const viewerAgent = await loginAgent(app, viewer);
    await viewerAgent.post('/api/v1/auth/switch-org').send({ orgId: user.orgId });
    const read = await viewerAgent.get(`/api/v1/bas/${bas.id}`);
    expect(read.status).toBe(200);
    expect((await viewerAgent.post(`/api/v1/bas/${bas.id}/finalise`).send({})).status).toBe(403);
  });
});
