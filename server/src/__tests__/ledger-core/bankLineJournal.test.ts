import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — posting a journal entry directly from a bank line (Phase
 * 20). Integration tier, real PostgreSQL. Covers the endpoint's own
 * cross-tenant isolation case (rule 15) alongside its rollback and
 * FSM-boundary behaviour.
 */

const app = createApp();
const BANK_IMPORTS = '/api/v1/ledger-core/bank-imports';
const BANK_TRANSACTIONS = '/api/v1/ledger-core/bank-transactions';
const JOURNALS = '/api/v1/ledger-core/journals';
const PERIODS = '/api/v1/ledger-core/fiscal-periods';

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let cashAccountId: string;
let feeAccountId: string; // 6600 Bank Fees
let interestAccountId: string; // a postable Revenue account, 4100
let headerAccountId: string; // 1100 Current Assets — not postable

type Agent = Awaited<ReturnType<typeof loginAgent>>;
let agentA: Agent;

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

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'bankjournal-a', orgName: 'Bank Journal Org A' });
  userB = await createUserWithOrg({ label: 'bankjournal-b', orgName: 'Bank Journal Org B' });
  orgA = userA.orgId;

  agentA = await loginAgent(app, userA);
  cashAccountId = await accountId(orgA, '1110');
  feeAccountId = await accountId(orgA, '6600');
  interestAccountId = await accountId(orgA, '4100');
  headerAccountId = await accountId(orgA, '1100');
});

afterAll(closePool);

describe('posting a journal entry for a withdrawal (money out)', () => {
  it('debits the chosen account and credits the bank account', async () => {
    const txnId = await importSingleLine(agentA, cashAccountId, '2026-06-01', 'MONTHLY SERVICE CHARGE', -3800);

    const res = await agentA
      .post(`${BANK_TRANSACTIONS}/${txnId}/post-journal`)
      .send({ accountId: feeAccountId, description: null });

    expect(res.status).toBe(200);
    expect(res.body.transaction.status).toBe('MATCHED');
    expect(res.body.transaction.matchedJournalEntryId).toBeTruthy();
    expect(res.body.transaction.matchedPaymentId).toBeNull();

    const entryId = res.body.transaction.matchedJournalEntryId as string;
    const entryRes = await agentA.get(`${JOURNALS}/${entryId}`);
    expect(entryRes.body.entry.sourceType).toBe('bank_line');
    expect(entryRes.body.entry.sourceId).toBe(txnId);

    const lines = entryRes.body.entry.lines as Array<{
      accountId: string;
      debitCents: number;
      creditCents: number;
    }>;
    const feeLine = lines.find((l) => l.accountId === feeAccountId);
    const cashLine = lines.find((l) => l.accountId === cashAccountId);
    expect(feeLine?.debitCents).toBe(3800);
    expect(feeLine?.creditCents).toBe(0);
    expect(cashLine?.debitCents).toBe(0);
    expect(cashLine?.creditCents).toBe(3800);
  });
});

describe('posting a journal entry for a deposit (money in)', () => {
  it('debits the bank account and credits the chosen account', async () => {
    const txnId = await importSingleLine(agentA, cashAccountId, '2026-06-01', 'INTEREST PAID', 1240);

    const res = await agentA
      .post(`${BANK_TRANSACTIONS}/${txnId}/post-journal`)
      .send({ accountId: interestAccountId, description: 'Interest income' });

    expect(res.status).toBe(200);
    const entryId = res.body.transaction.matchedJournalEntryId as string;
    const entryRes = await agentA.get(`${JOURNALS}/${entryId}`);
    expect(entryRes.body.entry.description).toBe('Interest income');

    const lines = entryRes.body.entry.lines as Array<{
      accountId: string;
      debitCents: number;
      creditCents: number;
    }>;
    const cashLine = lines.find((l) => l.accountId === cashAccountId);
    const interestLine = lines.find((l) => l.accountId === interestAccountId);
    expect(cashLine?.debitCents).toBe(1240);
    expect(cashLine?.creditCents).toBe(0);
    expect(interestLine?.debitCents).toBe(0);
    expect(interestLine?.creditCents).toBe(1240);
  });
});

describe('validation', () => {
  it('refuses to post back to the same bank account', async () => {
    const txnId = await importSingleLine(agentA, cashAccountId, '2026-06-01', 'Same account', -1000);
    const res = await agentA
      .post(`${BANK_TRANSACTIONS}/${txnId}/post-journal`)
      .send({ accountId: cashAccountId, description: null });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('cannot post back to the same bank account');
  });

  it('posting against a matched line is 409', async () => {
    const txnId = await importSingleLine(agentA, cashAccountId, '2026-06-01', 'Fee', -1000);
    await agentA.post(`${BANK_TRANSACTIONS}/${txnId}/post-journal`).send({ accountId: feeAccountId, description: null });

    const res = await agentA
      .post(`${BANK_TRANSACTIONS}/${txnId}/post-journal`)
      .send({ accountId: feeAccountId, description: null });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already matched');
  });

  it('posting against an ignored line is 409', async () => {
    const txnId = await importSingleLine(agentA, cashAccountId, '2026-06-01', 'Transfer', -5000);
    await agentA.post(`${BANK_TRANSACTIONS}/${txnId}/ignore`).send({});

    const res = await agentA
      .post(`${BANK_TRANSACTIONS}/${txnId}/post-journal`)
      .send({ accountId: feeAccountId, description: null });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('ignored');
  });

  it('posting against a non-postable header account is 422 and leaves the line unmatched', async () => {
    const txnId = await importSingleLine(agentA, cashAccountId, '2026-06-01', 'Bad account', -1000);
    const res = await agentA
      .post(`${BANK_TRANSACTIONS}/${txnId}/post-journal`)
      .send({ accountId: headerAccountId, description: null });
    expect(res.status).toBe(422);

    const txnRes = await agentA.get(`${BANK_TRANSACTIONS}/${txnId}`);
    expect(txnRes.body.transaction.status).toBe('UNMATCHED');

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM journal_entries WHERE org_id = $1 AND source_type = 'bank_line' AND source_id = $2`,
      [orgA, txnId],
    );
    expect(rows[0]?.count).toBe('0');
  });
});

describe('roles', () => {
  it('a VIEWER cannot post a journal from a bank line', async () => {
    const txnId = await importSingleLine(agentA, cashAccountId, '2026-06-01', 'Fee', -1000);

    const viewer = await createUserWithOrg({ label: 'bankjournal-viewer', orgName: 'unused' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const viewerAgent = await loginAgent(app, viewer);
    await viewerAgent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const res = await viewerAgent
      .post(`${BANK_TRANSACTIONS}/${txnId}/post-journal`)
      .send({ accountId: feeAccountId, description: null });
    expect(res.status).toBe(403);
  });
});

describe('cross-tenant isolation', () => {
  it("org B cannot post a journal entry against org A's bank line", async () => {
    const txnId = await importSingleLine(agentA, cashAccountId, '2026-06-01', 'Fee', -1000);

    const agentB = await loginAgent(app, userB);
    const feeAccountIdB = await accountId(userB.orgId, '6600');
    const res = await agentB
      .post(`${BANK_TRANSACTIONS}/${txnId}/post-journal`)
      .send({ accountId: feeAccountIdB, description: null });
    expect(res.status).toBe(404);

    const txnRes = await agentA.get(`${BANK_TRANSACTIONS}/${txnId}`);
    expect(txnRes.body.transaction.status).toBe('UNMATCHED');
    expect(txnRes.body.transaction.matchedJournalEntryId).toBeNull();
  });
});

describe('unmatch reverses the journal entry', () => {
  it('unmatching after post-journal reverses the entry and clears the cash movement', async () => {
    const txnId = await importSingleLine(agentA, cashAccountId, '2026-06-01', 'Fee', -3800);
    const matchRes = await agentA
      .post(`${BANK_TRANSACTIONS}/${txnId}/post-journal`)
      .send({ accountId: feeAccountId, description: null });
    const entryId = matchRes.body.transaction.matchedJournalEntryId as string;

    const unmatchRes = await agentA.post(`${BANK_TRANSACTIONS}/${txnId}/unmatch`).send({});
    expect(unmatchRes.status).toBe(200);
    expect(unmatchRes.body.transaction.status).toBe('UNMATCHED');
    expect(unmatchRes.body.transaction.matchedJournalEntryId).toBeNull();

    const { rows: reversalRows } = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM journal_entries WHERE reverses_entry_id = $1',
      [entryId],
    );
    expect(reversalRows[0]?.count).toBe('1');

    const { rows: balanceRows } = await pool.query<{ balance: string }>(
      `SELECT COALESCE(SUM(base_debit_cents - base_credit_cents), 0)::text AS balance
         FROM ledger_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
        WHERE l.account_id = $1`,
      [feeAccountId],
    );
    expect(balanceRows[0]?.balance).toBe('0');
  });
});

describe('fiscal period interaction', () => {
  it('posting into a closed fiscal period is refused', async () => {
    const onboardRes = await agentA.post('/api/v1/ledger-core/settings/onboarding').send({
      organizationName: 'Acme Books',
      baseCurrency: 'USD',
      fiscalYearStartMonth: 1,
      booksStartDate: '2026-01-01',
    });
    if (onboardRes.status !== 200) throw new Error(`fixture: onboarding failed ${onboardRes.status}`);

    const txnId = await importSingleLine(agentA, cashAccountId, '2026-01-15', 'Fee', -1000);

    const generateRes = await agentA.post(`${PERIODS}/generate`).send({ containingDate: '2026-01-15' });
    const januaryPeriod = (generateRes.body.periods as Array<{ id: string; startsOn: string }>).find((p) =>
      p.startsOn.startsWith('2026-01'),
    );
    if (januaryPeriod === undefined) throw new Error('fixture: no January period');
    await agentA.post(`${PERIODS}/${januaryPeriod.id}/close`).send({});

    const res = await agentA
      .post(`${BANK_TRANSACTIONS}/${txnId}/post-journal`)
      .send({ accountId: feeAccountId, description: null });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('period');

    const txnRes = await agentA.get(`${BANK_TRANSACTIONS}/${txnId}`);
    expect(txnRes.body.transaction.status).toBe('UNMATCHED');
  });
});
