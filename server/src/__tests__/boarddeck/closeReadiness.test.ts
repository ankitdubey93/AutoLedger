import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { closeReadiness } from '../../services/ledger-core/reportService.js';
import { ApiError } from '../../utils/apiError.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore's closeReadiness bridge (Phase 15) — the only route BoardDeck
 * takes into invoices, bills, bank_transactions and the ledger
 * (guardrails rule 16). Fixtures go through the real API, exactly as
 * invoices.test.ts/bills.test.ts/bankImports.test.ts build theirs, so every
 * CHECK constraint on those tables is satisfied for free.
 */

const app = createApp();
const JOURNALS = '/api/v1/ledger-core/journals';
const CUSTOMERS = '/api/v1/ledger-core/customers';
const INVOICES = '/api/v1/ledger-core/invoices';
const VENDORS = '/api/v1/ledger-core/vendors';
const BILLS = '/api/v1/ledger-core/bills';
const BANK_IMPORTS = '/api/v1/ledger-core/bank-imports';
const BANK_TRANSACTIONS = '/api/v1/ledger-core/bank-transactions';

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;

type Agent = Awaited<ReturnType<typeof loginAgent>>;

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id = $1 AND code = $2', [
    orgId,
    code,
  ]);
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
}

async function postJournalCents(
  agent: Agent,
  debitAccountId: string,
  creditAccountId: string,
  amountCents: number,
  entryDate: string,
) {
  return agent.post(JOURNALS).send({
    entryDate,
    description: `fixture ${String(amountCents)}`,
    lines: [
      { accountId: debitAccountId, debitCents: amountCents, creditCents: 0 },
      { accountId: creditAccountId, debitCents: 0, creditCents: amountCents },
    ],
  });
}

async function createDraftInvoice(agent: Agent, orgId: string, issueDate: string): Promise<void> {
  const revenueAccountId = await accountId(orgId, '4100');
  const customerRes = await agent.post(CUSTOMERS).send({ name: `Customer ${issueDate}` });
  const customerId = customerRes.body.customer.id as string;

  const res = await agent.post(INVOICES).send({
    customerId,
    issueDate,
    dueDate: '2026-12-31',
    notes: null,
    paymentTerms: null,
    lines: [
      {
        description: 'Consulting',
        quantityMilli: 1000,
        unitPriceCents: 10000,
        revenueAccountId,
        taxRateBp: 0,
      },
    ],
  });
  if (res.status !== 201) throw new Error(`fixture: invoice create failed ${res.status} ${JSON.stringify(res.body)}`);
}

async function issueInvoice(agent: Agent, orgId: string, issueDate: string): Promise<void> {
  const revenueAccountId = await accountId(orgId, '4100');
  const customerRes = await agent.post(CUSTOMERS).send({ name: `Customer issued ${issueDate}` });
  const customerId = customerRes.body.customer.id as string;

  const created = await agent.post(INVOICES).send({
    customerId,
    issueDate,
    dueDate: '2026-12-31',
    notes: null,
    paymentTerms: null,
    lines: [
      { description: 'Consulting', quantityMilli: 1000, unitPriceCents: 10000, revenueAccountId, taxRateBp: 0 },
    ],
  });
  const invoiceId = created.body.invoice.id as string;
  const issueRes = await agent.post(`${INVOICES}/${invoiceId}/issue`).send({});
  if (issueRes.status !== 200) throw new Error(`fixture: invoice issue failed ${issueRes.status}`);
}

async function createBill(
  agent: Agent,
  orgId: string,
  billDate: string,
  advanceTo: 'DRAFT' | 'AWAITING_APPROVAL' | 'POSTED' | 'VOID',
): Promise<void> {
  const expenseAccountId = await accountId(orgId, '6100');
  const vendorRes = await agent.post(VENDORS).send({ name: `Vendor ${billDate}-${advanceTo}` });
  const vendorId = vendorRes.body.vendor.id as string;

  const created = await agent.post(BILLS).send({
    vendorId,
    vendorReference: 'REF',
    billDate,
    dueDate: '2026-12-31',
    notes: null,
    paymentTerms: null,
    lines: [
      { description: 'Supplies', quantityMilli: 1000, unitPriceCents: 10000, expenseAccountId, taxRateBp: 0 },
    ],
  });
  const billId = created.body.bill.id as string;
  if (advanceTo === 'DRAFT') return;

  const submitted = await agent.post(`${BILLS}/${billId}/submit`).send({});
  if (submitted.status !== 200) throw new Error(`fixture: bill submit failed ${submitted.status}`);
  if (advanceTo === 'AWAITING_APPROVAL') return;

  if (advanceTo === 'POSTED') {
    const approved = await agent.post(`${BILLS}/${billId}/approve`).send({});
    if (approved.status !== 200) throw new Error(`fixture: bill approve failed ${approved.status}`);
    return;
  }

  // VOID
  const approved = await agent.post(`${BILLS}/${billId}/approve`).send({});
  if (approved.status !== 200) throw new Error(`fixture: bill approve failed ${approved.status}`);
  const voided = await agent.post(`${BILLS}/${billId}/void`).send({});
  if (voided.status !== 200) throw new Error(`fixture: bill void failed ${voided.status}`);
}

async function importBankLines(agent: Agent, accountIdForImport: string, rows: string[]): Promise<void> {
  const content = ['Date,Description,Amount', ...rows].join('\n');
  const res = await agent
    .post(BANK_IMPORTS)
    .send({ accountId: accountIdForImport, fileName: `stmt-${Math.random().toString(36).slice(2)}.csv`, content, dateFormat: 'ISO' });
  if (res.status !== 201) throw new Error(`fixture: bank import failed ${res.status} ${JSON.stringify(res.body)}`);
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userB.orgId;
});

afterAll(closePool);

describe('reportService.closeReadiness', () => {
  it('sums only base_* columns inside the date window', async () => {
    const agent = await loginAgent(app, userA);
    const cashId = await accountId(orgA, '1110');
    const revenueId = await accountId(orgA, '4100');

    await postJournalCents(agent, cashId, revenueId, 100_000, '2026-06-15');
    await postJournalCents(agent, cashId, revenueId, 50_000, '2026-07-15');

    const r = await closeReadiness(orgA, '2026-06-01', '2026-06-30');
    expect(r.totalDebitCents).toBe(100_000);
    expect(r.totalCreditCents).toBe(100_000);
  });

  it('counts a DRAFT invoice and ignores an ISSUED one', async () => {
    const agent = await loginAgent(app, userA);
    await createDraftInvoice(agent, orgA, '2026-06-10');
    await issueInvoice(agent, orgA, '2026-06-11');

    const r = await closeReadiness(orgA, '2026-06-01', '2026-06-30');
    expect(r.draftInvoiceCount).toBe(1);
  });

  it('counts DRAFT and AWAITING_APPROVAL bills, ignores POSTED and VOID', async () => {
    const agent = await loginAgent(app, userA);
    await createBill(agent, orgA, '2026-06-01', 'DRAFT');
    await createBill(agent, orgA, '2026-06-02', 'AWAITING_APPROVAL');
    await createBill(agent, orgA, '2026-06-03', 'POSTED');
    await createBill(agent, orgA, '2026-06-04', 'VOID');

    const r = await closeReadiness(orgA, '2026-06-01', '2026-06-30');
    expect(r.unpostedBillCount).toBe(2);
  });

  it('counts UNMATCHED bank lines only', async () => {
    const agent = await loginAgent(app, userA);
    const cashId = await accountId(orgA, '1110');
    await importBankLines(agent, cashId, [
      '2026-06-01,Unmatched line,100.00',
      '2026-06-02,Ignored line,50.00',
    ]);

    const list = await agent.get(`${BANK_TRANSACTIONS}?accountId=${cashId}`);
    const ignoredId = (list.body.transactions as { id: string; description: string }[]).find((t) =>
      t.description.includes('Ignored'),
    )?.id;
    if (ignoredId === undefined) throw new Error('fixture: could not find ignored line');
    const ignoreRes = await agent.post(`${BANK_TRANSACTIONS}/${ignoredId}/ignore`).send({});
    if (ignoreRes.status !== 200) throw new Error(`fixture: ignore failed ${ignoreRes.status}`);

    const r = await closeReadiness(orgA, '2026-06-01', '2026-06-30');
    expect(r.unmatchedBankLineCount).toBe(1);
  });

  it('from after to is rejected', async () => {
    await expect(closeReadiness(orgA, '2026-07-01', '2026-06-01')).rejects.toMatchObject({
      status: 422,
    } as Partial<ApiError>);
  });

  it('org B data never reaches org A counts', async () => {
    const agentA = await loginAgent(app, userA);
    const cashA = await accountId(orgA, '1110');
    const revenueA = await accountId(orgA, '4100');
    await postJournalCents(agentA, cashA, revenueA, 1000, '2026-06-15');
    await createDraftInvoice(agentA, orgA, '2026-06-10');

    const before = await closeReadiness(orgA, '2026-06-01', '2026-06-30');

    const agentB = await loginAgent(app, userB);
    const cashB = await accountId(orgB, '1110');
    const revenueB = await accountId(orgB, '4100');
    for (let i = 0; i < 10; i++) {
      await postJournalCents(agentB, cashB, revenueB, 100_000, '2026-06-15');
    }
    await createDraftInvoice(agentB, orgB, '2026-06-10');
    await createBill(agentB, orgB, '2026-06-10', 'DRAFT');
    await importBankLines(agentB, cashB, ['2026-06-05,Org B line,100.00']);

    const after = await closeReadiness(orgA, '2026-06-01', '2026-06-30');
    expect(after).toEqual(before);
  });
});
