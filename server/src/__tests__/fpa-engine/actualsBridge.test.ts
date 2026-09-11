import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { ApiError } from '../../utils/apiError.js';
import { monthlyActualsByAccount, resolveControlAccounts } from '../../services/ledger-core/reportService.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

const app = createApp();
const JOURNALS = '/api/v1/ledger-core/journals';

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code}`);
  return row.id;
}

async function sale(orgId: string, amountCents: number, entryDate: string) {
  return {
    entryDate,
    description: `Sale ${String(amountCents)}`,
    lines: [
      { accountId: await accountId(orgId, '1110'), debitCents: amountCents, creditCents: 0 },
      { accountId: await accountId(orgId, '4100'), debitCents: 0, creditCents: amountCents },
    ],
  };
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  orgA = userA.orgId;
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgB = userB.orgId;
});

afterAll(closePool);

describe('fpa-engine actuals bridge (reportService)', () => {
  it('1. buckets multiple entries in the same month together, across two months', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(JOURNALS).send(await sale(orgA, 10000, '2026-07-15'));
    await agent.post(JOURNALS).send(await sale(orgA, 20000, '2026-08-20'));
    await agent.post(JOURNALS).send(await sale(orgA, 5000, '2026-08-25'));

    const rows = await monthlyActualsByAccount(orgA, '2026-07-01', '2026-08-31');
    const months = new Set(rows.map((r) => r.month));
    expect(months.size).toBe(2);
    expect(months.has('2026-07-01')).toBe(true);
    expect(months.has('2026-08-01')).toBe(true);

    const augustRevenue = rows.find((r) => r.month === '2026-08-01' && r.code === '4100');
    expect(augustRevenue?.creditCents).toBe(25000);
  });

  it('2. an org with no postings returns an empty array', async () => {
    const rows = await monthlyActualsByAccount(orgB, '2026-07-01', '2026-08-31');
    expect(rows).toEqual([]);
  });

  it('3. cross-tenant activity in the same month does not leak into another org\'s totals', async () => {
    const agentA = await loginAgent(app, userA);
    await agentA.post(JOURNALS).send(await sale(orgA, 10000, '2026-08-10'));

    const agentB = await loginAgent(app, userB);
    await agentB.post(JOURNALS).send(await sale(orgB, 500000, '2026-08-10'));

    const rows = await monthlyActualsByAccount(orgA, '2026-08-01', '2026-08-31');
    const revenue = rows.find((r) => r.code === '4100');
    expect(revenue?.creditCents).toBe(10000);
  });

  it('4. throws a 422 ApiError when from is after to', async () => {
    await expect(monthlyActualsByAccount(orgA, '2026-08-01', '2026-07-01')).rejects.toMatchObject({
      status: 422,
    } satisfies Partial<ApiError>);
  });

  it('5. resolves control accounts to the default-chart codes when nothing is configured', async () => {
    const control = await resolveControlAccounts(orgA);
    expect(control.cashAccountId).toBe(await accountId(orgA, '1110'));
    expect(control.receivableAccountId).toBe(await accountId(orgA, '1120'));
    expect(control.payableAccountId).toBe(await accountId(orgA, '2100'));
  });

  it('6. a configured cash_account_id wins over the fallback code', async () => {
    const inventoryId = await accountId(orgA, '1140');

    // ledger_settings has no seed row (migration 005: absence IS "onboarding
    // not yet completed") — insert one directly so there is a row to update.
    await pool.query(
      `INSERT INTO ledger_settings (org_id, fiscal_year_start_month, books_start_date, cash_account_id)
       VALUES ($1, 1, '2026-01-01', $2)`,
      [orgA, inventoryId],
    );

    const control = await resolveControlAccounts(orgA);
    expect(control.cashAccountId).toBe(inventoryId);
  });

  it('7. every returned cents figure is an integer', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(JOURNALS).send(await sale(orgA, 12345, '2026-08-01'));

    const rows = await monthlyActualsByAccount(orgA, '2026-08-01', '2026-08-31');
    for (const row of rows) {
      expect(Number.isInteger(row.debitCents)).toBe(true);
      expect(Number.isInteger(row.creditCents)).toBe(true);
    }
  });
});
