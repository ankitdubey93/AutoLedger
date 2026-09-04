import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import { buildHundredLineStatement } from '../helpers/bankFixture.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — bank line matching (Phase 6). Integration tier, real
 * PostgreSQL. Includes this module's own cross-tenant isolation cases
 * (rule 15) and the roadmap's confidence-scoring acceptance criterion.
 */

const app = createApp();
const BANK_IMPORTS = '/api/v1/ledger-core/bank-imports';
const BANK_TRANSACTIONS = '/api/v1/ledger-core/bank-transactions';
const INVOICES = '/api/v1/ledger-core/invoices';
const BILLS = '/api/v1/ledger-core/bills';
const CUSTOMERS = '/api/v1/ledger-core/customers';
const VENDORS = '/api/v1/ledger-core/vendors';
const PAYMENTS = '/api/v1/ledger-core/payments';
const PERIODS = '/api/v1/ledger-core/fiscal-periods';
const ONBOARDING = '/api/v1/ledger-core/settings/onboarding';

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;

type Agent = Awaited<ReturnType<typeof loginAgent>>;
let agentA: Agent;
let cashAccountId: string;
let revenueAccountId: string;
let expenseAccountId: string;
let customerId: string;
let vendorId: string;

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
}

async function seedIssuedInvoice(
  agent: Agent,
  amountCents: number,
  issueDate = '2026-06-01',
): Promise<{ id: string; invoiceNumber: string; totalCents: number }> {
  const created = await agent.post(INVOICES).send({
    customerId,
    issueDate,
    dueDate: '2026-12-31',
    notes: null,
    paymentTerms: null,
    lines: [
      {
        description: 'Consulting',
        quantityMilli: 1000,
        unitPriceCents: amountCents,
        revenueAccountId,
        taxRateBp: 0,
      },
    ],
  });
  const invoiceId = created.body.invoice.id as string;
  const issued = await agent.post(`${INVOICES}/${invoiceId}/issue`).send({});
  return { id: invoiceId, invoiceNumber: issued.body.invoice.invoiceNumber as string, totalCents: amountCents };
}

async function seedPostedBill(
  agent: Agent,
  amountCents: number,
  billDate = '2026-06-01',
): Promise<{ id: string; totalCents: number }> {
  const created = await agent.post(BILLS).send({
    vendorId,
    vendorReference: `VEND-${String(Math.floor(Math.random() * 1_000_000))}`,
    billDate,
    dueDate: '2026-12-31',
    notes: null,
    paymentTerms: null,
    lines: [
      {
        description: 'Supplies',
        quantityMilli: 1000,
        unitPriceCents: amountCents,
        expenseAccountId,
        taxRateBp: 0,
      },
    ],
  });
  const billId = created.body.bill.id as string;
  await agent.post(`${BILLS}/${billId}/submit`).send({});
  await agent.post(`${BILLS}/${billId}/approve`).send({});
  return { id: billId, totalCents: amountCents };
}

async function importSingleLine(
  agent: Agent,
  accId: string,
  date: string,
  description: string,
  amountCents: number,
): Promise<string> {
  const amountText = (amountCents / 100).toFixed(2);
  const res = await agent.post(BANK_IMPORTS).send({
    accountId: accId,
    fileName: 'single.csv',
    content: `Date,Description,Amount\n${date},${description},${amountText}`,
    dateFormat: 'ISO',
  });
  if (res.status !== 201) throw new Error(`fixture: import failed ${res.status} ${JSON.stringify(res.body)}`);
  const listRes = await agent.get(`${BANK_TRANSACTIONS}?accountId=${accId}&status=UNMATCHED&limit=100`);
  const transactions = listRes.body.transactions as Array<{ id: string; description: string }>;
  const txn = transactions.find((t) => t.description === description);
  if (txn === undefined) throw new Error('fixture: imported transaction not found');
  return txn.id;
}

async function onboard(agent: Agent): Promise<void> {
  const res = await agent.post(ONBOARDING).send({
    organizationName: 'Acme Books',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    booksStartDate: '2026-01-01',
  });
  if (res.status !== 200) throw new Error(`fixture: onboarding failed ${res.status} ${res.text}`);
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'bankmatch-a', orgName: 'Bank Match Org A' });
  userB = await createUserWithOrg({ label: 'bankmatch-b', orgName: 'Bank Match Org B' });
  orgA = userA.orgId;
  orgB = userB.orgId;

  agentA = await loginAgent(app, userA);
  cashAccountId = await accountId(orgA, '1110');
  revenueAccountId = await accountId(orgA, '4100');
  expenseAccountId = await accountId(orgA, '6130');

  const customerRes = await agentA.post(CUSTOMERS).send({ name: 'Northwind Traders' });
  customerId = customerRes.body.customer.id as string;
  const vendorRes = await agentA.post(VENDORS).send({ name: 'Acme Supplies' });
  vendorId = vendorRes.body.vendor.id as string;
});

afterAll(closePool);

describe('confidence scoring', () => {
  it('scores a known-good 100-line statement with no false auto-reconcile', async () => {
    const fixture = await buildHundredLineStatement(agentA, customerId, revenueAccountId);

    const importRes = await agentA.post(BANK_IMPORTS).send({
      accountId: cashAccountId,
      fileName: 'hundred.csv',
      content: fixture.csv,
      dateFormat: 'ISO',
    });
    expect(importRes.status).toBe(201);
    expect(importRes.body.importedCount).toBe(100);

    const listRes = await agentA.get(`${BANK_TRANSACTIONS}?accountId=${cashAccountId}&limit=100`);
    const transactions = listRes.body.transactions as Array<{
      description: string;
      suggestions: Array<{ score: number; invoiceId: string | null }>;
    }>;
    expect(transactions.length).toBe(100);

    let falsePositives = 0;
    let autoMatchableCount = 0;

    for (const txn of transactions) {
      const expectedInvoiceId = fixture.trueMatchByDescription.get(txn.description) ?? null;
      for (const suggestion of txn.suggestions) {
        if (suggestion.score >= 85) {
          autoMatchableCount++;
          if (expectedInvoiceId === null || suggestion.invoiceId !== expectedInvoiceId) {
            falsePositives++;
          }
        }
      }
    }

    expect(falsePositives).toBe(0);
    expect(autoMatchableCount).toBeGreaterThanOrEqual(30);
  }, 60_000);

  it('a near-miss on amount never reaches the threshold', async () => {
    const invoice = await seedIssuedInvoice(agentA, 50000);
    const txnId = await importSingleLine(
      agentA,
      cashAccountId,
      '2026-06-01',
      `PMT ${invoice.invoiceNumber}`,
      50001,
    );
    const res = await agentA.get(`${BANK_TRANSACTIONS}/${txnId}`);
    const suggestions = res.body.transaction.suggestions as Array<{ score: number }>;
    for (const s of suggestions) {
      expect(s.score).toBeLessThan(85);
    }
  });
});

describe('match / unmatch', () => {
  it('accepting a suggestion posts a balanced payment', async () => {
    const invoice = await seedIssuedInvoice(agentA, 40000);
    const txnId = await importSingleLine(
      agentA,
      cashAccountId,
      '2026-06-01',
      `PAYMENT RECEIVED ${invoice.invoiceNumber}`,
      40000,
    );

    const before = await agentA.get(`${BANK_TRANSACTIONS}/${txnId}`);
    const suggestion = (before.body.transaction.suggestions as Array<{ id: string; score: number }>)[0];
    expect(suggestion).toBeDefined();
    expect(suggestion?.score).toBe(100);

    const matchRes = await agentA
      .post(`${BANK_TRANSACTIONS}/${txnId}/match`)
      .send({ suggestionId: suggestion?.id });
    expect(matchRes.status).toBe(200);

    const invoiceRes = await agentA.get(`${INVOICES}/${invoice.id}`);
    expect(invoiceRes.body.invoice.amountDueCents).toBe(0);

    const paymentId = matchRes.body.transaction.matchedPaymentId as string;
    const paymentRes = await agentA.get(`${PAYMENTS}/${paymentId}`);
    const journalEntryId = paymentRes.body.payment.journalEntryId as string;

    const { rows } = await pool.query<{ debit: string; credit: string }>(
      `SELECT COALESCE(SUM(debit_cents),0)::text AS debit, COALESCE(SUM(credit_cents),0)::text AS credit
         FROM ledger_lines WHERE journal_entry_id = $1`,
      [journalEntryId],
    );
    expect(rows[0]?.debit).toBe(rows[0]?.credit);
  });

  it('a matched line reports MATCHED with a payment id', async () => {
    const invoice = await seedIssuedInvoice(agentA, 40000);
    const txnId = await importSingleLine(
      agentA,
      cashAccountId,
      '2026-06-01',
      `PAYMENT RECEIVED ${invoice.invoiceNumber}`,
      40000,
    );
    const before = await agentA.get(`${BANK_TRANSACTIONS}/${txnId}`);
    const suggestion = (before.body.transaction.suggestions as Array<{ id: string }>)[0];

    const matchRes = await agentA
      .post(`${BANK_TRANSACTIONS}/${txnId}/match`)
      .send({ suggestionId: suggestion?.id });

    expect(matchRes.body.transaction.status).toBe('MATCHED');
    expect(matchRes.body.transaction.matchedPaymentId).toBeTruthy();
    expect(matchRes.body.transaction.suggestions).toEqual([]);
  });

  it('unmatching voids the payment and restores the amount due', async () => {
    const invoice = await seedIssuedInvoice(agentA, 40000);
    const txnId = await importSingleLine(
      agentA,
      cashAccountId,
      '2026-06-01',
      `PAYMENT RECEIVED ${invoice.invoiceNumber}`,
      40000,
    );
    const before = await agentA.get(`${BANK_TRANSACTIONS}/${txnId}`);
    const suggestion = (before.body.transaction.suggestions as Array<{ id: string }>)[0];
    const matchRes = await agentA
      .post(`${BANK_TRANSACTIONS}/${txnId}/match`)
      .send({ suggestionId: suggestion?.id });
    const paymentId = matchRes.body.transaction.matchedPaymentId as string;

    const unmatchRes = await agentA.post(`${BANK_TRANSACTIONS}/${txnId}/unmatch`).send({});
    expect(unmatchRes.status).toBe(200);
    expect(unmatchRes.body.transaction.status).toBe('UNMATCHED');

    const paymentRes = await agentA.get(`${PAYMENTS}/${paymentId}`);
    expect(paymentRes.body.payment.status).toBe('VOID');

    const invoiceRes = await agentA.get(`${INVOICES}/${invoice.id}`);
    expect(invoiceRes.body.invoice.amountDueCents).toBe(40000);
  });

  it('unmatching regenerates suggestions', async () => {
    const invoice = await seedIssuedInvoice(agentA, 40000);
    const txnId = await importSingleLine(
      agentA,
      cashAccountId,
      '2026-06-01',
      `PAYMENT RECEIVED ${invoice.invoiceNumber}`,
      40000,
    );
    const before = await agentA.get(`${BANK_TRANSACTIONS}/${txnId}`);
    const suggestion = (before.body.transaction.suggestions as Array<{ id: string }>)[0];
    await agentA.post(`${BANK_TRANSACTIONS}/${txnId}/match`).send({ suggestionId: suggestion?.id });

    await agentA.post(`${BANK_TRANSACTIONS}/${txnId}/unmatch`).send({});

    const after = await agentA.get(`${BANK_TRANSACTIONS}/${txnId}`);
    expect((after.body.transaction.suggestions as unknown[]).length).toBeGreaterThan(0);
  });

  it('a deposit cannot be matched to a bill', async () => {
    const bill = await seedPostedBill(agentA, 30000);
    const txnId = await importSingleLine(agentA, cashAccountId, '2026-06-01', 'Unrelated deposit', 30000);

    const res = await agentA.post(`${BANK_TRANSACTIONS}/${txnId}/match`).send({ billId: bill.id });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('deposit');
  });

  it('a withdrawal cannot be matched to an invoice', async () => {
    const invoice = await seedIssuedInvoice(agentA, 30000);
    const txnId = await importSingleLine(agentA, cashAccountId, '2026-06-01', 'Unrelated withdrawal', -30000);

    const res = await agentA.post(`${BANK_TRANSACTIONS}/${txnId}/match`).send({ invoiceId: invoice.id });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('withdrawal');
  });

  it('a line larger than the amount due is refused', async () => {
    const invoice = await seedIssuedInvoice(agentA, 30000);
    const txnId = await importSingleLine(agentA, cashAccountId, '2026-06-01', 'Overpayment', 50000);

    const res = await agentA.post(`${BANK_TRANSACTIONS}/${txnId}/match`).send({ invoiceId: invoice.id });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('exceeds the amount still due');
  });

  it('matching an already-matched line is 409', async () => {
    const invoice = await seedIssuedInvoice(agentA, 40000);
    const txnId = await importSingleLine(agentA, cashAccountId, '2026-06-01', 'Payment', 40000);
    await agentA.post(`${BANK_TRANSACTIONS}/${txnId}/match`).send({ invoiceId: invoice.id });

    const res = await agentA.post(`${BANK_TRANSACTIONS}/${txnId}/match`).send({ invoiceId: invoice.id });
    expect(res.status).toBe(409);
  });

  it('unmatching an unmatched line is 409', async () => {
    const txnId = await importSingleLine(agentA, cashAccountId, '2026-06-01', 'Unlinked', 5000);
    const res = await agentA.post(`${BANK_TRANSACTIONS}/${txnId}/unmatch`).send({});
    expect(res.status).toBe(409);
  });
});

describe('ignore / unignore', () => {
  it('ignoring then un-ignoring returns to UNMATCHED with suggestions', async () => {
    const invoice = await seedIssuedInvoice(agentA, 40000);
    const txnId = await importSingleLine(
      agentA,
      cashAccountId,
      '2026-06-01',
      `PAYMENT RECEIVED ${invoice.invoiceNumber}`,
      40000,
    );

    const ignoreRes = await agentA.post(`${BANK_TRANSACTIONS}/${txnId}/ignore`).send({});
    expect(ignoreRes.status).toBe(200);
    expect(ignoreRes.body.transaction.status).toBe('IGNORED');

    const unignoreRes = await agentA.post(`${BANK_TRANSACTIONS}/${txnId}/unignore`).send({});
    expect(unignoreRes.status).toBe(200);
    expect(unignoreRes.body.transaction.status).toBe('UNMATCHED');
    expect((unignoreRes.body.transaction.suggestions as unknown[]).length).toBeGreaterThan(0);
  });

  it('a matched line cannot be ignored', async () => {
    const invoice = await seedIssuedInvoice(agentA, 40000);
    const txnId = await importSingleLine(agentA, cashAccountId, '2026-06-01', 'Payment', 40000);
    await agentA.post(`${BANK_TRANSACTIONS}/${txnId}/match`).send({ invoiceId: invoice.id });

    const res = await agentA.post(`${BANK_TRANSACTIONS}/${txnId}/ignore`).send({});
    expect(res.status).toBe(409);
  });
});

describe('rescore', () => {
  it('rescoring a matched line is 422', async () => {
    const invoice = await seedIssuedInvoice(agentA, 40000);
    const txnId = await importSingleLine(agentA, cashAccountId, '2026-06-01', 'Payment', 40000);
    await agentA.post(`${BANK_TRANSACTIONS}/${txnId}/match`).send({ invoiceId: invoice.id });

    const res = await agentA.post(`${BANK_TRANSACTIONS}/${txnId}/rescore`).send({});
    expect(res.status).toBe(422);
  });
});

describe('roles', () => {
  it('a VIEWER cannot match', async () => {
    const invoice = await seedIssuedInvoice(agentA, 40000);
    const txnId = await importSingleLine(agentA, cashAccountId, '2026-06-01', 'Payment', 40000);

    const viewer = await createUserWithOrg({ label: 'bankmatch-viewer', orgName: 'unused' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const viewerAgent = await loginAgent(app, viewer);
    await viewerAgent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const res = await viewerAgent.post(`${BANK_TRANSACTIONS}/${txnId}/match`).send({ invoiceId: invoice.id });
    expect(res.status).toBe(403);
  });
});

describe('cross-tenant isolation', () => {
  it("org B cannot match org A's bank line", async () => {
    const invoice = await seedIssuedInvoice(agentA, 40000);
    const txnId = await importSingleLine(agentA, cashAccountId, '2026-06-01', 'Payment', 40000);

    const agentB = await loginAgent(app, userB);
    const res = await agentB.post(`${BANK_TRANSACTIONS}/${txnId}/match`).send({ invoiceId: invoice.id });
    expect(res.status).toBe(404);
  });

  it("a suggestion cannot name another tenant's invoice", async () => {
    const invoice = await seedIssuedInvoice(agentA, 40000);

    const agentB = await loginAgent(app, userB);
    const cashAccountIdB = await accountId(orgB, '1110');
    const txnIdB = await importSingleLine(agentB, cashAccountIdB, '2026-06-01', 'Cross tenant', 40000);

    const res = await agentB.post(`${BANK_TRANSACTIONS}/${txnIdB}/match`).send({ invoiceId: invoice.id });
    expect(res.status).toBe(422);
  });
});

describe('fiscal period interaction', () => {
  it('matching inside a closed fiscal period is refused', async () => {
    await onboard(agentA);
    const invoice = await seedIssuedInvoice(agentA, 40000, '2026-01-15');
    const txnId = await importSingleLine(agentA, cashAccountId, '2026-01-15', 'Payment', 40000);

    const generateRes = await agentA.post(`${PERIODS}/generate`).send({ containingDate: '2026-01-15' });
    const januaryPeriod = (generateRes.body.periods as Array<{ id: string; startsOn: string }>).find((p) =>
      p.startsOn.startsWith('2026-01'),
    );
    if (januaryPeriod === undefined) throw new Error('fixture: no January period');
    await agentA.post(`${PERIODS}/${januaryPeriod.id}/close`).send({});

    const res = await agentA.post(`${BANK_TRANSACTIONS}/${txnId}/match`).send({ invoiceId: invoice.id });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('closed');

    const txnRes = await agentA.get(`${BANK_TRANSACTIONS}/${txnId}`);
    expect(txnRes.body.transaction.status).toBe('UNMATCHED');
  });
});
