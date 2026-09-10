import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — the staged opening-balance importer (Phase 9b). Integration
 * tier, real PostgreSQL. Includes this module's own cross-tenant isolation
 * case (rule 15).
 */

const app = createApp();
const IMPORTS = '/api/v1/ledger-core/migration-imports';
const ONBOARDING = '/api/v1/ledger-core/settings/onboarding';
const PERIODS = '/api/v1/ledger-core/fiscal-periods';
const JOURNALS = '/api/v1/ledger-core/journals';
const BALANCE_SHEET = '/api/v1/ledger-core/reports/balance-sheet';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let userC: SeededUser;
let orgA: string;
let orgB: string;
let agentA: Agent;

async function onboard(agent: Agent, overrides: Record<string, unknown> = {}) {
  const res = await agent.post(ONBOARDING).send({
    organizationName: 'Acme Books',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    booksStartDate: '2026-01-01',
    ...overrides,
  });
  if (res.status !== 200) throw new Error(`fixture: onboarding failed ${res.status} ${res.text}`);
  return res;
}

interface StagedRow {
  id: string;
  accountCode: string | null;
  status: string;
  errors: string[];
}

function rowByCode(rows: StagedRow[], code: string): StagedRow {
  const row = rows.find((r) => r.accountCode === code);
  if (row === undefined) throw new Error(`fixture: no staged row for code ${code}`);
  return row;
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

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'obi-a', orgName: 'OBI Org A' });
  userC = await createUserWithOrg({ label: 'obi-c', orgName: 'OBI Org C' });
  orgA = userA.orgId;
  orgB = userC.orgId;

  agentA = await loginAgent(app, userA);
  await onboard(agentA);
});

afterAll(closePool);

it('an unbalanced trial balance imports, commits with the difference in 3400, and the balance sheet still balances', async () => {
  const content = ['Code,Debit,Credit', '1110,10000.00,', '4100,,7000.00'].join('\n');

  const created = await agentA
    .post(IMPORTS)
    .send({ kind: 'OPENING_BALANCES', fileName: 'trial-balance.csv', content });
  expect(created.status).toBe(201);
  expect(created.body.import.status).toBe('VALIDATED');
  const importId = created.body.import.id as string;

  const preview = await agentA.get(`${IMPORTS}/${importId}/preview`);
  expect(preview.body.preview.plugCents).toBe(300000);

  const commit = await agentA.post(`${IMPORTS}/${importId}/commit`);
  expect(commit.status).toBe(200);

  const balanceSheet = await agentA.get(`${BALANCE_SHEET}?asOf=2026-12-31`);
  expect(balanceSheet.body.balances).toBe(true);

  expect(await net3400(orgA)).toBe(300000);
});

it('a balanced trial balance posts no 3400 line at all', async () => {
  const content = ['Code,Debit,Credit', '1110,5000.00,', '4100,,5000.00'].join('\n');

  const created = await agentA
    .post(IMPORTS)
    .send({ kind: 'OPENING_BALANCES', fileName: 'balanced.csv', content });
  const importId = created.body.import.id as string;

  const preview = await agentA.get(`${IMPORTS}/${importId}/preview`);
  expect(preview.body.preview.plugCents).toBe(0);

  const commit = await agentA.post(`${IMPORTS}/${importId}/commit`);
  expect(commit.status).toBe(200);

  const entry = await agentA.get(`${JOURNALS}/${commit.body.result.journalEntryId}`);
  const lineAccountCodes = (entry.body.entry.lines as { accountCode: string }[]).map((l) => l.accountCode);
  expect(lineAccountCodes).not.toContain('3400');

  expect(await net3400(orgA)).toBe(0);
});

it("the opening entry is dated books_start_date with source_type 'opening_balance'", async () => {
  const content = ['Code,Debit,Credit', '1110,1000.00,', '4100,,1000.00'].join('\n');

  const created = await agentA
    .post(IMPORTS)
    .send({ kind: 'OPENING_BALANCES', fileName: 'dated.csv', content });
  const importId = created.body.import.id as string;

  const commit = await agentA.post(`${IMPORTS}/${importId}/commit`);
  const entry = await agentA.get(`${JOURNALS}/${commit.body.result.journalEntryId}`);

  expect(entry.body.entry.entryDate).toBe('2026-01-01');
  expect(entry.body.entry.sourceType).toBe('opening_balance');
  expect(entry.body.entry.sourceId).toBe(importId);
});

it('a row on 3200 Retained Earnings is refused', async () => {
  const content = ['Code,Debit,Credit', '3200,,1000.00'].join('\n');

  const created = await agentA
    .post(IMPORTS)
    .send({ kind: 'OPENING_BALANCES', fileName: 'retained.csv', content });
  const row = rowByCode(created.body.rows as StagedRow[], '3200');
  expect(row.errors.some((e) => e.startsWith('3200 Retained Earnings is derived'))).toBe(true);

  const commit = await agentA.post(`${IMPORTS}/${created.body.import.id}/commit`);
  expect(commit.status).toBe(409);
});

it('a row on the receivable control account is refused', async () => {
  const content = ['Code,Debit,Credit', '1120,1000.00,'].join('\n');

  const created = await agentA
    .post(IMPORTS)
    .send({ kind: 'OPENING_BALANCES', fileName: 'receivable.csv', content });
  const row = rowByCode(created.body.rows as StagedRow[], '1120');
  expect(row.errors.some((e) => e.includes('/ledger-core/invoices'))).toBe(true);
});

it('a row on the payable control account is refused', async () => {
  const content = ['Code,Debit,Credit', '2100,,1000.00'].join('\n');

  const created = await agentA
    .post(IMPORTS)
    .send({ kind: 'OPENING_BALANCES', fileName: 'payable.csv', content });
  const row = rowByCode(created.body.rows as StagedRow[], '2100');
  expect(row.errors.some((e) => e.includes('/ledger-core/bills'))).toBe(true);
});

it('all five account types are accepted, and year-to-date revenue leaves derived retained earnings at zero', async () => {
  const content = [
    'Code,Debit,Credit',
    '1110,10000.00,',
    '2120,,2000.00',
    '3100,,3000.00',
    '4100,,4000.00',
    '6100,,1000.00',
  ].join('\n');
  // One Asset debit (10000) balanced against a Liability, Equity, Revenue and
  // Expense credit (2000+3000+4000+1000=10000) — every account type touched,
  // zero plug needed. 2120 Accrued Liabilities, not 2100 Accounts Payable —
  // 2100 is the refused payable control account (the next two tests). Dated
  // at the fiscal year's own start, so nothing here is "prior year" and
  // derived retained earnings must read zero regardless.

  const created = await agentA
    .post(IMPORTS)
    .send({ kind: 'OPENING_BALANCES', fileName: 'all-types.csv', content });
  expect(created.body.import.status).toBe('VALIDATED');

  const commit = await agentA.post(`${IMPORTS}/${created.body.import.id}/commit`);
  expect(commit.status).toBe(200);

  const balanceSheet = await agentA.get(`${BALANCE_SHEET}?asOf=2026-12-31`);
  expect(balanceSheet.body.equity.retainedEarningsCents).toBe(0);
});

it('a second committed opening-balance import is refused', async () => {
  const first = await agentA
    .post(IMPORTS)
    .send({ kind: 'OPENING_BALANCES', fileName: 'first.csv', content: ['Code,Debit,Credit', '1110,1000.00,', '4100,,1000.00'].join('\n') });
  const firstCommit = await agentA.post(`${IMPORTS}/${first.body.import.id}/commit`);
  expect(firstCommit.status).toBe(200);

  const second = await agentA
    .post(IMPORTS)
    .send({ kind: 'OPENING_BALANCES', fileName: 'second.csv', content: ['Code,Debit,Credit', '1110,500.00,', '4100,,500.00'].join('\n') });
  const secondCommit = await agentA.post(`${IMPORTS}/${second.body.import.id}/commit`);
  expect(secondCommit.status).toBe(409);

  // The index is the guarantee, not the service: force a second row to
  // VALIDATED and attempt the same raw UPDATE the service issues — it must
  // be the database, not application logic, that refuses it.
  await pool.query("UPDATE migration_imports SET status = 'VALIDATED' WHERE id = $1", [second.body.import.id]);
  await expect(
    pool.query("UPDATE migration_imports SET status = 'COMMITTED', committed_at = now() WHERE id = $1", [
      second.body.import.id,
    ]),
  ).rejects.toMatchObject({ code: '23505', constraint: 'ux_migration_imports_one_committed_opening' });
});

it('an opening balance dated inside a CLOSED period is refused', async () => {
  const generate = await agentA.post(`${PERIODS}/generate`).send({ containingDate: '2026-01-15' });
  const januaryId = (generate.body.periods as { id: string; startsOn: string }[]).find((p) =>
    p.startsOn.startsWith('2026-01'),
  )?.id;
  if (januaryId === undefined) throw new Error('fixture: no January period generated');
  await agentA.post(`${PERIODS}/${januaryId}/close`);

  const content = ['Code,Debit,Credit', '1110,1000.00,', '4100,,1000.00'].join('\n');
  const created = await agentA
    .post(IMPORTS)
    .send({ kind: 'OPENING_BALANCES', fileName: 'closed-period.csv', content });

  const commit = await agentA.post(`${IMPORTS}/${created.body.import.id}/commit`);
  expect(commit.status).toBe(422);
});

describe('cross-tenant isolation', () => {
  it("org A's commit never posts into org B's ledger", async () => {
    const agentC = await loginAgent(app, userC);
    await onboard(agentC);

    const content = ['Code,Debit,Credit', '1110,1000.00,', '4100,,1000.00'].join('\n');
    const created = await agentA
      .post(IMPORTS)
      .send({ kind: 'OPENING_BALANCES', fileName: 'a-only.csv', content });
    const commit = await agentA.post(`${IMPORTS}/${created.body.import.id}/commit`);
    expect(commit.status).toBe(200);

    const orgBJournals = await agentC.get(JOURNALS).query({ sourceType: 'opening_balance' });
    expect(orgBJournals.body.entries).toHaveLength(0);

    const { rows } = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM journal_entries WHERE org_id = $1 AND source_type = 'opening_balance'",
      [orgB],
    );
    expect(rows[0]?.count).toBe('0');
  });
});
