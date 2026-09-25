import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Accounting — bank rules (Phase 34a). Integration tier, real PostgreSQL.
 * Covers this module's own cross-tenant isolation cases (rule 15) alongside
 * validation, priority ordering, the "a document suggestion always wins"
 * rule, rollback on a refused posting, and unmatch.
 */

const app = createApp();
const BANK_RULES = '/api/v1/bank-rules';
const BANK_IMPORTS = '/api/v1/bank-imports';
const BANK_TRANSACTIONS = '/api/v1/bank-transactions';
const JOURNALS = '/api/v1/journals';
const INVOICES = '/api/v1/invoices';
const CUSTOMERS = '/api/v1/customers';
const PERIODS = '/api/v1/fiscal-periods';
const ONBOARDING = '/api/v1/settings/onboarding';

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;

type Agent = Awaited<ReturnType<typeof loginAgent>>;
let agentA: Agent;
let agentB: Agent;
let cashAccountId: string;
let feeAccountId: string; // 6600 Bank Fees
let arAccountId: string; // 1120 Accounts Receivable — the AR control account
let revenueAccountId: string; // 4100
let customerId: string;

async function accountId(org: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [org, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${org}`);
  return row.id;
}

async function importSingleLine(
  agent: Agent,
  accId: string,
  date: string,
  description: string,
  amountCents: number,
): Promise<{ id: string; body: Record<string, unknown> }> {
  const amountText = (amountCents / 100).toFixed(2);
  const res = await agent.post(BANK_IMPORTS).send({
    accountId: accId,
    fileName: 'single.csv',
    content: `Date,Description,Amount\n${date},${description},${amountText}`,
    dateFormat: 'ISO',
  });
  if (res.status !== 201) throw new Error(`fixture: import failed ${res.status} ${JSON.stringify(res.body)}`);
  const listRes = await agent.get(`${BANK_TRANSACTIONS}?accountId=${accId}&limit=100`);
  const transactions = listRes.body.transactions as Array<{ id: string; description: string }>;
  const txn = transactions.find((t) => t.description === description);
  if (txn === undefined) throw new Error('fixture: imported transaction not found');
  return { id: txn.id, body: res.body as Record<string, unknown> };
}

async function seedIssuedInvoice(
  agent: Agent,
  amountCents: number,
  issueDate = '2026-06-01',
): Promise<{ id: string; invoiceNumber: string }> {
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
  return { id: invoiceId, invoiceNumber: issued.body.invoice.invoiceNumber as string };
}

async function createRule(
  agent: Agent,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await agent.post(BANK_RULES).send({
    name: 'Bank rule',
    memoContains: 'FEE',
    targetAccountId: feeAccountId,
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`fixture: create rule failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.bankRule as Record<string, unknown>;
}

async function closeJanuaryPeriod(agent: Agent): Promise<void> {
  const onboardRes = await agent.post(ONBOARDING).send({
    organizationName: 'Acme Books',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    booksStartDate: '2026-01-01',
  });
  if (onboardRes.status !== 200) throw new Error(`fixture: onboarding failed ${onboardRes.status}`);

  const generateRes = await agent.post(`${PERIODS}/generate`).send({ containingDate: '2026-01-15' });
  const januaryPeriod = (generateRes.body.periods as Array<{ id: string; startsOn: string }>).find((p) =>
    p.startsOn.startsWith('2026-01'),
  );
  if (januaryPeriod === undefined) throw new Error('fixture: no January period');
  await agent.post(`${PERIODS}/${januaryPeriod.id}/close`).send({});
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'bankrules-a', orgName: 'Bank Rules Org A' });
  userB = await createUserWithOrg({ label: 'bankrules-b', orgName: 'Bank Rules Org B' });
  orgA = userA.orgId;
  orgB = userB.orgId;

  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  cashAccountId = await accountId(orgA, '1110');
  feeAccountId = await accountId(orgA, '6600');
  arAccountId = await accountId(orgA, '1120');
  revenueAccountId = await accountId(orgA, '4100');

  const customerRes = await agentA.post(CUSTOMERS).send({ name: 'Northwind Traders' });
  customerId = customerRes.body.customer.id as string;
});

afterAll(closePool);

describe('create and list', () => {
  it('POST /bank-rules creates a rule and GET lists it with the target account code', async () => {
    const created = await createRule(agentA);
    expect(created.targetAccountCode).toBe('6600');

    const listRes = await agentA.get(BANK_RULES);
    expect(listRes.status).toBe(200);
    const rules = listRes.body.bankRules as Array<{ id: string; targetAccountCode: string }>;
    const found = rules.find((r) => r.id === created.id);
    expect(found?.targetAccountCode).toBe('6600');
  });

  it('a rule targeting the AR control account is refused', async () => {
    const res = await agentA.post(BANK_RULES).send({
      name: 'Bad rule',
      memoContains: 'FEE',
      targetAccountId: arAccountId,
    });
    expect(res.status).toBe(422);
  });

  it('a rule posting back to its own bank account is refused', async () => {
    const res = await agentA.post(BANK_RULES).send({
      name: 'Bad rule',
      memoContains: 'FEE',
      bankAccountId: cashAccountId,
      targetAccountId: cashAccountId,
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('A rule cannot post back to its own bank account');
  });
});

describe('import applies matching rules', () => {
  it('import settles a matching fee line by rule and reports ruleMatchedCount', async () => {
    const rule = await createRule(agentA, { memoContains: 'SERVICE CHARGE', targetAccountId: feeAccountId });

    const { id: txnId, body } = await importSingleLine(
      agentA,
      cashAccountId,
      '2026-06-01',
      'MONTHLY SERVICE CHARGE',
      -3800,
    );
    expect(body.ruleMatchedCount).toBe(1);

    const txnRes = await agentA.get(`${BANK_TRANSACTIONS}/${txnId}`);
    expect(txnRes.body.transaction.status).toBe('MATCHED');
    expect(txnRes.body.transaction.matchedRuleId).toBe(rule.id);
    expect(txnRes.body.transaction.matchedRuleName).toBe(rule.name);

    const entryId = txnRes.body.transaction.matchedJournalEntryId as string;
    const entryRes = await agentA.get(`${JOURNALS}/${entryId}`);
    const lines = entryRes.body.entry.lines as Array<{ accountId: string; debitCents: number; creditCents: number }>;
    const feeLine = lines.find((l) => l.accountId === feeAccountId);
    const cashLine = lines.find((l) => l.accountId === cashAccountId);
    expect(feeLine?.debitCents).toBe(3800);
    expect(feeLine?.creditCents).toBe(0);
    expect(cashLine?.debitCents).toBe(0);
    expect(cashLine?.creditCents).toBe(3800);
  });

  it('a line with an auto-matchable document suggestion is left for the document, not the rule', async () => {
    const invoice = await seedIssuedInvoice(agentA, 12500);
    await createRule(agentA, { memoContains: 'PAYMENT', name: 'Catch-all', direction: 'ANY' });

    const { id: txnId, body } = await importSingleLine(
      agentA,
      cashAccountId,
      '2026-06-01',
      `PAYMENT RECEIVED ${invoice.invoiceNumber}`,
      12500,
    );
    expect(body.ruleMatchedCount).toBe(0);

    const txnRes = await agentA.get(`${BANK_TRANSACTIONS}/${txnId}`);
    expect(txnRes.body.transaction.status).toBe('UNMATCHED');
    const suggestions = txnRes.body.transaction.suggestions as Array<{ score: number }>;
    expect(suggestions.some((s) => s.score >= 85)).toBe(true);
  });

  it('lower priority number wins when two rules match', async () => {
    const highPriorityAccount = feeAccountId;
    const lowPriorityAccount = revenueAccountId;
    await createRule(agentA, { name: 'Low priority', priority: 50, targetAccountId: lowPriorityAccount });
    await createRule(agentA, { name: 'High priority', priority: 10, targetAccountId: highPriorityAccount });

    const { id: txnId } = await importSingleLine(agentA, cashAccountId, '2026-06-01', 'FEE CHARGE', -1500);

    const txnRes = await agentA.get(`${BANK_TRANSACTIONS}/${txnId}`);
    const entryId = txnRes.body.transaction.matchedJournalEntryId as string;
    const entryRes = await agentA.get(`${JOURNALS}/${entryId}`);
    const lines = entryRes.body.entry.lines as Array<{ accountId: string }>;
    expect(lines.some((l) => l.accountId === highPriorityAccount)).toBe(true);
    expect(lines.some((l) => l.accountId === lowPriorityAccount)).toBe(false);
  });

  it('a rule whose posting is refused leaves the line unmatched and the import succeeds', async () => {
    await createRule(agentA);
    await closeJanuaryPeriod(agentA);

    const importRes = await agentA.post(BANK_IMPORTS).send({
      accountId: cashAccountId,
      fileName: 'closed.csv',
      content: 'Date,Description,Amount\n2026-01-15,FEE CHARGE,-15.00',
      dateFormat: 'ISO',
    });
    expect(importRes.status).toBe(201);
    expect(importRes.body.ruleMatchedCount).toBe(0);

    const listRes = await agentA.get(`${BANK_TRANSACTIONS}?accountId=${cashAccountId}&limit=100`);
    const transactions = listRes.body.transactions as Array<{ description: string; status: string; id: string }>;
    const txn = transactions.find((t) => t.description === 'FEE CHARGE');
    expect(txn?.status).toBe('UNMATCHED');

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM journal_entries WHERE org_id = $1 AND source_type = 'bank_line' AND source_id = $2`,
      [orgA, txn?.id],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('unmatch reverses a rule posting and clears matchedRuleId', async () => {
    await createRule(agentA, { memoContains: 'FEE', targetAccountId: feeAccountId });
    const { id: txnId } = await importSingleLine(agentA, cashAccountId, '2026-06-01', 'FEE CHARGE', -3800);

    const unmatchRes = await agentA.post(`${BANK_TRANSACTIONS}/${txnId}/unmatch`).send({});
    expect(unmatchRes.status).toBe(200);
    expect(unmatchRes.body.transaction.matchedRuleId).toBeNull();

    const { rows: balanceRows } = await pool.query<{ balance: string }>(
      `SELECT COALESCE(SUM(base_debit_cents - base_credit_cents), 0)::text AS balance
         FROM ledger_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
        WHERE l.account_id = $1`,
      [feeAccountId],
    );
    expect(balanceRows[0]?.balance).toBe('0');
  });

  it('POST /bank-rules/apply settles previously imported unmatched lines', async () => {
    const { id: txnId } = await importSingleLine(agentA, cashAccountId, '2026-06-01', 'FEE CHARGE', -3800);
    await createRule(agentA, { memoContains: 'FEE', targetAccountId: feeAccountId });

    const applyRes = await agentA.post(`${BANK_RULES}/apply`).send({});
    expect(applyRes.status).toBe(200);
    expect(applyRes.body.appliedCount).toBe(1);

    const txnRes = await agentA.get(`${BANK_TRANSACTIONS}/${txnId}`);
    expect(txnRes.body.transaction.status).toBe('MATCHED');
  });

  it('an inactive rule is ignored', async () => {
    const rule = await createRule(agentA, { memoContains: 'FEE', targetAccountId: feeAccountId });
    await agentA.patch(`${BANK_RULES}/${rule.id as string}`).send({ isActive: false });

    const { body } = await importSingleLine(agentA, cashAccountId, '2026-06-01', 'FEE CHARGE', -3800);
    expect(body.ruleMatchedCount).toBe(0);
  });
});

describe('roles', () => {
  it('a VIEWER cannot create a rule', async () => {
    const viewer = await createUserWithOrg({ label: 'bankrules-viewer', orgName: 'unused' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const viewerAgent = await loginAgent(app, viewer);
    await viewerAgent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const res = await viewerAgent.post(BANK_RULES).send({
      name: 'Bank rule',
      memoContains: 'FEE',
      targetAccountId: feeAccountId,
    });
    expect(res.status).toBe(403);
  });
});

describe('cross-tenant isolation', () => {
  it('org B cannot see or update org A rules', async () => {
    const rule = await createRule(agentA);

    const listRes = await agentB.get(BANK_RULES);
    expect(listRes.status).toBe(200);
    expect(listRes.body.count).toBe(0);

    const patchRes = await agentB.patch(`${BANK_RULES}/${rule.id as string}`).send({ isActive: false });
    expect(patchRes.status).toBe(404);
  });

  it('org A rules never settle org B lines', async () => {
    await createRule(agentA, { memoContains: 'SERVICE CHARGE', targetAccountId: feeAccountId });

    const cashAccountIdB = await accountId(orgB, '1110');
    const { body } = await importSingleLine(agentB, cashAccountIdB, '2026-06-01', 'MONTHLY SERVICE CHARGE', -3800);
    expect(body.ruleMatchedCount).toBe(0);
  });

  it('a rule cannot target another org account', async () => {
    const feeAccountIdB = await accountId(orgB, '6600');
    const res = await agentA.post(BANK_RULES).send({
      name: 'Cross-org rule',
      memoContains: 'FEE',
      targetAccountId: feeAccountIdB,
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Target account not found');
  });
});
