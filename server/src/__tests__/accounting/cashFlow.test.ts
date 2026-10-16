import type { Response } from 'superagent';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { createEntryOnClient } from '../../services/accounting/journalService.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId, createCustomer, issueInvoice, postBill, receivePayment } from '../helpers/accountingFixtures.js';
import type { Agent } from '../helpers/accountingFixtures.js';
import { createVendor } from '../helpers/depositFixtures.js';

/**
 * Cash flow statement (Phase 45, indirect method). Integration tier, real
 * PostgreSQL. The statement's net change must equal the cash accounts'
 * movement; overrides move an account between sections; nothing crosses tenants.
 */

const app = createApp();
const REPORTS = '/api/v1/reports';
const FROM = '2026-09-01';
const TO = '2026-09-30';

interface Row {
  accountId: string;
  code: string;
  amountCents: number;
  categorySource: 'OVERRIDE' | 'DERIVED';
}
interface Section {
  rows: Row[];
  totalCents: number;
}
interface Statement {
  netIncomeCents: number;
  operating: Section;
  investing: Section;
  financing: Section;
  netChangeCents: number;
  openingCashCents: number;
  closingCashCents: number;
}

function binary(res: Response, cb: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

let userA: SeededUser;
let orgA: string;
let orgB: string;
let agentA: Agent;
let agentB: Agent;

async function statement(agent: Agent): Promise<Statement> {
  const res = await agent.get(`${REPORTS}/cash-flow`).query({ from: FROM, to: TO });
  expect(res.status).toBe(200);
  return res.body as Statement;
}

async function postManual(lines: { code: string; debit?: number; credit?: number }[]): Promise<void> {
  const res = await agentA.post('/api/v1/manual-journals').send({
    narration: 'Cash flow fixture',
    entryDate: '2026-09-15',
    action: 'post',
    lines: await Promise.all(
      lines.map(async (l) => ({
        accountId: await accountId(orgA, l.code),
        description: null,
        debitCents: l.debit ?? 0,
        creditCents: l.credit ?? 0,
      })),
    ),
  });
  if (res.status !== 201) throw new Error(`fixture: manual journal failed ${res.status} ${JSON.stringify(res.body)}`);
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  const userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userB.orgId;
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);

  const customerId = await createCustomer(agentA, 'Acme');
  const invoice = await issueInvoice(agentA, orgA, customerId, 100000, '2026-09-05', '2026-12-31');
  await receivePayment(agentA, orgA, customerId, '2026-09-10', [{ invoiceId: invoice.id, amountCents: 60000 }]);

  const vendorId = await createVendor(agentA, 'Supplier');
  const bill = await postBill(agentA, orgA, vendorId, { billDate: '2026-09-08', unitPriceCents: 30000 });
  const pay = await agentA.post('/api/v1/payments').send({
    direction: 'PAY',
    paymentDate: '2026-09-12',
    amountCents: 30000,
    cashAccountId: await accountId(orgA, '1110'),
    vendorId,
    allocations: [{ invoiceId: null, billId: bill.id, amountCents: 30000 }],
  });
  if (pay.status !== 201) throw new Error(`fixture: bill payment failed ${pay.status} ${JSON.stringify(pay.body)}`);

  await postManual([
    { code: '1500', debit: 50000 },
    { code: '2510', credit: 50000 },
  ]);

  const cash = await accountId(orgA, '1110');
  const capital = await accountId(orgA, '3100');
  await withTransaction(async (client) => {
    await createEntryOnClient(client, orgA, userA.id, {
      entryDate: '2026-09-25',
      description: 'Capital',
      sourceType: 'manual',
      lines: [
        { accountId: cash, debitCents: 100000, creditCents: 0 },
        { accountId: capital, debitCents: 0, creditCents: 100000 },
      ],
    });
  });
});

afterAll(closePool);

describe('GET /reports/cash-flow', () => {
  it('sections', async () => {
    const s = await statement(agentA);

    expect(s.netIncomeCents).toBe(70000);
    expect(s.operating.totalCents).toBe(30000);
    expect(s.operating.rows.map((r) => [r.code, r.amountCents])).toEqual([['1120', -40000]]);
    expect(s.investing.totalCents).toBe(-50000);
    expect(s.investing.rows.map((r) => [r.code, r.amountCents])).toEqual([['1500', -50000]]);
    expect(s.financing.totalCents).toBe(150000);
    expect(s.financing.rows.map((r) => [r.code, r.amountCents])).toEqual([
      ['2510', 50000],
      ['3100', 100000],
    ]);
    expect(s.netChangeCents).toBe(130000);
    expect(s.closingCashCents - s.openingCashCents).toBe(130000);
  });

  it('depreciation is operating', async () => {
    await postManual([
      { code: '6500', debit: 10000 },
      { code: '1590', credit: 10000 },
    ]);
    const s = await statement(agentA);

    expect(s.netIncomeCents).toBe(60000);
    expect(s.operating.rows.find((r) => r.code === '1590')?.amountCents).toBe(10000);
    expect(s.investing.rows.some((r) => r.code === '1590')).toBe(false);
    expect(s.netChangeCents).toBe(130000);
  });

  it('override moves an account', async () => {
    const res = await agentA
      .patch(`/api/v1/accounts/${await accountId(orgA, '1500')}`)
      .send({ cashFlowCategory: 'OPERATING' });
    expect(res.status).toBe(200);

    const s = await statement(agentA);
    expect(s.investing.totalCents).toBe(0);
    expect(s.investing.rows).toEqual([]);
    expect(s.operating.rows.find((r) => r.code === '1500')?.categorySource).toBe('OVERRIDE');
    expect(s.netChangeCents).toBe(130000);
  });

  it('override refused on revenue', async () => {
    const res = await agentA
      .patch(`/api/v1/accounts/${await accountId(orgA, '4100')}`)
      .send({ cashFlowCategory: 'OPERATING' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Only balance-sheet accounts have a cash flow category');
  });

  it('DB check', async () => {
    await expect(
      pool.query("UPDATE accounts SET cash_flow_category = 'CASH' WHERE code = '4100' AND org_id = $1", [orgA]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('seeded 1590', async () => {
    const res = await agentA.get('/api/v1/accounts');
    expect(res.status).toBe(200);
    const accounts = res.body.accounts as { code: string; cashFlowCategory: string | null }[];
    expect(accounts.find((a) => a.code === '1590')?.cashFlowCategory).toBe('OPERATING');
    expect(accounts.find((a) => a.code === '1500')?.cashFlowCategory).toBeNull();
  });

  it('cross-tenant', async () => {
    expect(orgB).not.toBe(orgA);
    const s = await statement(agentB);

    expect(s.netChangeCents).toBe(0);
    expect(s.operating.rows).toEqual([]);
    expect(s.investing.rows).toEqual([]);
    expect(s.financing.rows).toEqual([]);
  });

  it('pdf export', async () => {
    const res = await agentA
      .get(`${REPORTS}/cash-flow`)
      .query({ from: FROM, to: TO, format: 'pdf' })
      .buffer(true)
      .parse(binary);

    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
