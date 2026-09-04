import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — bank reconciliation report (Phase 6). Integration tier, real
 * PostgreSQL. Includes this module's own cross-tenant isolation case
 * (rule 15).
 */

const app = createApp();
const RECONCILIATION = '/api/v1/ledger-core/reports/bank-reconciliation';
const BANK_IMPORTS = '/api/v1/ledger-core/bank-imports';
const BANK_TRANSACTIONS = '/api/v1/ledger-core/bank-transactions';
const INVOICES = '/api/v1/ledger-core/invoices';
const JOURNALS = '/api/v1/ledger-core/journals';
const CUSTOMERS = '/api/v1/ledger-core/customers';

const AS_OF = '2026-06-30';

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;

type Agent = Awaited<ReturnType<typeof loginAgent>>;
let agentA: Agent;
let cashAccountId: string;
let revenueAccountId: string;
let customerId: string;

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
}

async function seedIssuedInvoice(amountCents: number): Promise<{ id: string; invoiceNumber: string }> {
  const created = await agentA.post(INVOICES).send({
    customerId,
    issueDate: '2026-06-01',
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
  const issued = await agentA.post(`${INVOICES}/${invoiceId}/issue`).send({});
  return { id: invoiceId, invoiceNumber: issued.body.invoice.invoiceNumber as string };
}

async function importSingleLine(
  date: string,
  description: string,
  amountCents: number,
  closingBalanceCents: number | null = null,
  closingBalanceOn: string | null = null,
): Promise<string> {
  const amountText = (amountCents / 100).toFixed(2);
  const res = await agentA.post(BANK_IMPORTS).send({
    accountId: cashAccountId,
    fileName: 'single.csv',
    content: `Date,Description,Amount\n${date},${description},${amountText}`,
    dateFormat: 'ISO',
    closingBalanceCents,
    closingBalanceOn,
  });
  if (res.status !== 201) throw new Error(`fixture: import failed ${res.status} ${JSON.stringify(res.body)}`);
  const listRes = await agentA.get(`${BANK_TRANSACTIONS}?accountId=${cashAccountId}&status=UNMATCHED&limit=50`);
  const transactions = listRes.body.transactions as Array<{ id: string; description: string }>;
  const txn = transactions.find((t) => t.description === description);
  if (txn === undefined) throw new Error('fixture: imported transaction not found');
  return txn.id;
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'bankrecon-a', orgName: 'Bank Recon Org A' });
  userB = await createUserWithOrg({ label: 'bankrecon-b', orgName: 'Bank Recon Org B' });
  orgA = userA.orgId;

  agentA = await loginAgent(app, userA);
  cashAccountId = await accountId(orgA, '1110');
  revenueAccountId = await accountId(orgA, '4100');

  const customerRes = await agentA.post(CUSTOMERS).send({ name: 'Northwind Traders' });
  customerId = customerRes.body.customer.id as string;
});

afterAll(closePool);

describe('GET /reports/bank-reconciliation', () => {
  it('reconciles when every bank line is matched and nothing else touched cash', async () => {
    const invoice = await seedIssuedInvoice(40000);
    const txnId = await importSingleLine('2026-06-01', `PAYMENT RECEIVED ${invoice.invoiceNumber}`, 40000);
    const txnRes = await agentA.get(`${BANK_TRANSACTIONS}/${txnId}`);
    const suggestion = (txnRes.body.transaction.suggestions as Array<{ id: string }>)[0];
    await agentA.post(`${BANK_TRANSACTIONS}/${txnId}/match`).send({ suggestionId: suggestion?.id });

    const res = await agentA.get(`${RECONCILIATION}?accountId=${cashAccountId}&asOf=${AS_OF}`);
    expect(res.status).toBe(200);
    expect(res.body.reconciles).toBe(true);
    expect(res.body.differenceCents).toBe(0);
  });

  it('does not reconcile when a cash movement was never imported', async () => {
    const revenueAccId = revenueAccountId;
    await agentA.post(JOURNALS).send({
      entryDate: '2026-06-05',
      description: 'Unimported cash movement',
      lines: [
        { accountId: cashAccountId, debitCents: 15000, creditCents: 0 },
        { accountId: revenueAccId, debitCents: 0, creditCents: 15000 },
      ],
    });

    const res = await agentA.get(`${RECONCILIATION}?accountId=${cashAccountId}&asOf=${AS_OF}`);
    expect(res.body.reconciles).toBe(false);
    expect(res.body.differenceCents).not.toBe(0);
  });

  it('an unmatched line still counts toward the statement balance', async () => {
    await importSingleLine('2026-06-01', 'Unlinked deposit', 5000);

    const res = await agentA.get(`${RECONCILIATION}?accountId=${cashAccountId}&asOf=${AS_OF}`);
    expect(res.body.unmatchedCount).toBe(1);
    expect(res.body.statementBalanceCents).toBe(5000);
  });

  it('an ignored line is excluded from the statement balance', async () => {
    const txnId = await importSingleLine('2026-06-01', 'To be ignored', 5000);
    await agentA.post(`${BANK_TRANSACTIONS}/${txnId}/ignore`).send({});

    const res = await agentA.get(`${RECONCILIATION}?accountId=${cashAccountId}&asOf=${AS_OF}`);
    expect(res.body.statementBalanceCents).toBe(0);
    expect(res.body.ignoredCount).toBe(1);
  });

  it('reports the stated closing balance difference when one was supplied', async () => {
    await importSingleLine('2026-06-01', 'Deposit', 5000, 12345, '2026-06-01');

    const res = await agentA.get(`${RECONCILIATION}?accountId=${cashAccountId}&asOf=${AS_OF}`);
    expect(res.body.statedClosingBalanceCents).toBe(12345);
    expect(res.body.statedClosingDifferenceCents).toBe(5000 - 12345);
  });

  it('omits the stated closing balance when none was supplied', async () => {
    await importSingleLine('2026-06-01', 'Deposit', 5000);

    const res = await agentA.get(`${RECONCILIATION}?accountId=${cashAccountId}&asOf=${AS_OF}`);
    expect(res.body.statedClosingBalanceCents).toBeNull();
    expect(res.body.statedClosingBalanceOn).toBeNull();
    expect(res.body.statedClosingDifferenceCents).toBeNull();
  });

  it('requires accountId', async () => {
    const res = await agentA.get(RECONCILIATION);
    expect(res.status).toBe(400);
  });

  it("cross-tenant: org B asking about org A's account sees zeroes, not org A's figures", async () => {
    await importSingleLine('2026-06-01', 'Deposit', 5000);

    const agentB = await loginAgent(app, userB);
    const cashAccountIdB = await accountId(userB.orgId, '1110');
    const res = await agentB.get(`${RECONCILIATION}?accountId=${cashAccountIdB}&asOf=${AS_OF}`);

    expect(res.status).toBe(200);
    expect(res.body.glBalanceCents).toBe(0);
    expect(res.body.statementBalanceCents).toBe(0);
    expect(res.body.unmatchedCount).toBe(0);
  });
});
