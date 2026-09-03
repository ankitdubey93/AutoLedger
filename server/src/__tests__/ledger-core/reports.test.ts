import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { trialBalance } from '../../services/ledger-core/reportService.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — the trial balance. Integration tier.
 *
 * Computed from raw ledger lines on every request, with no summary table
 * anywhere in the schema. The last test in this file asserts that.
 */

const app = createApp();
const JOURNALS = '/api/v1/ledger-core/journals';
const TRIAL_BALANCE = '/api/v1/ledger-core/reports/trial-balance';

let userA: SeededUser;
let userC: SeededUser;
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

/** A revenue sale: debit cash, credit service revenue. */
async function sale(orgId: string, amountCents: number, entryDate = '2026-08-15') {
  return {
    entryDate,
    description: `Sale ${String(amountCents)}`,
    lines: [
      { accountId: await accountId(orgId, '1110'), debitCents: amountCents, creditCents: 0 },
      { accountId: await accountId(orgId, '4200'), debitCents: 0, creditCents: amountCents },
    ],
  };
}

function row(body: { rows: { code: string }[] }, code: string) {
  const found = body.rows.find((r) => r.code === code);
  if (found === undefined) throw new Error(`no trial balance row for ${code}`);
  return found as unknown as {
    code: string;
    type: string;
    debitCents: number;
    creditCents: number;
    netBalanceCents: number;
  };
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userC = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userC.orgId;
});

afterAll(closePool);

describe('trial balance', () => {
  it('an organization with no postings is balanced at zero', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(TRIAL_BALANCE);

    expect(res.status).toBe(200);
    expect(res.body.totalDebitCents).toBe(0);
    expect(res.body.totalCreditCents).toBe(0);
    expect(res.body.isBalanced).toBe(true);
  });

  it('lists only postable, active accounts — never header rollups', async () => {
    const agent = await loginAgent(app, userA);
    const { body } = await agent.get(TRIAL_BALANCE);

    // 34 of the 44 seeded accounts are postable leaves.
    expect(body.count).toBe(34);
    expect(body.rows.some((r: { code: string }) => r.code === '1000')).toBe(false);
    expect(body.rows.some((r: { code: string }) => r.code === '1110')).toBe(true);
  });

  it('shows a posted entry against both of its accounts', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(JOURNALS).send(await sale(orgA, 45000));

    const { body } = await agent.get(TRIAL_BALANCE);

    expect(row(body, '1110').debitCents).toBe(45000);
    expect(row(body, '4200').creditCents).toBe(45000);
    expect(body.totalDebitCents).toBe(45000);
    expect(body.totalCreditCents).toBe(45000);
    expect(body.isBalanced).toBe(true);
  });

  it('is type-aware: a debit-balance account and a credit-balance account both read positive', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(JOURNALS).send(await sale(orgA, 45000));

    const { body } = await agent.get(TRIAL_BALANCE);

    // Cash is an Asset — debits are positive for it.
    expect(row(body, '1110').type).toBe('Asset');
    expect(row(body, '1110').netBalanceCents).toBe(45000);

    // Service Revenue is Revenue — credits are positive for it. A raw
    // debit-minus-credit would report all income as negative.
    expect(row(body, '4200').type).toBe('Revenue');
    expect(row(body, '4200').netBalanceCents).toBe(45000);
  });

  it('sums many entries exactly, with no floating-point drift', async () => {
    const agent = await loginAgent(app, userA);
    // Ten postings of 1 cent. As floats, ten times 0.01 is 0.09999999999999999.
    for (let i = 0; i < 10; i += 1) {
      await agent.post(JOURNALS).send(await sale(orgA, 1));
    }

    const { body } = await agent.get(TRIAL_BALANCE);

    expect(row(body, '1110').debitCents).toBe(10);
    expect(body.totalDebitCents).toBe(10);
    expect(body.isBalanced).toBe(true);
  });

  it('?asOf excludes entries dated after the cutoff', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(JOURNALS).send(await sale(orgA, 10000, '2026-07-31'));
    await agent.post(JOURNALS).send(await sale(orgA, 25000, '2026-08-15'));

    const july = await agent.get(TRIAL_BALANCE).query({ asOf: '2026-07-31' });
    expect(july.body.totalDebitCents).toBe(10000);
    expect(july.body.isBalanced).toBe(true);

    const august = await agent.get(TRIAL_BALANCE).query({ asOf: '2026-08-31' });
    expect(august.body.totalDebitCents).toBe(35000);

    // Accounts with no lines in the window still appear, at zero.
    expect(july.body.count).toBe(34);
  });

  it('rejects a malformed asOf', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(TRIAL_BALANCE).query({ asOf: 'last-tuesday' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/YYYY-MM-DD/);
  });

  it('excludes a retired account once it has been deactivated', async () => {
    const agent = await loginAgent(app, userA);
    const id = await accountId(orgA, '1140');
    await agent.patch(`/api/v1/ledger-core/accounts/${id}`).send({ isActive: false });

    const { body } = await agent.get(TRIAL_BALANCE);
    expect(body.count).toBe(33);
  });

  it('is derived, not stored — no summary table exists', async () => {
    // The claim in docs/ledger-core.md is that statements are computed from raw
    // ledger lines with no pre-calculated balances. This asserts the schema
    // genuinely has nowhere to cache one.
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'`,
    );
    const names = rows.map((r) => r.table_name);
    expect(names).not.toContain('account_balances');
    expect(names).not.toContain('trial_balances');

    const { rows: columns } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'accounts'`,
    );
    expect(columns.map((c) => c.column_name)).not.toContain('balance_cents');
  });
});

describe('cross-tenant isolation', () => {
  it("org A's trial balance never includes org B's postings", async () => {
    const agentC = await loginAgent(app, userC);
    await agentC.post(JOURNALS).send(await sale(orgB, 99999));

    const agentA = await loginAgent(app, userA);
    const { body } = await agentA.get(TRIAL_BALANCE);

    expect(body.totalDebitCents).toBe(0);
    expect(body.text).toBeUndefined();
    expect(row(body, '1110').debitCents).toBe(0);
  });

  it('the service layer is scoped even when called directly', async () => {
    const agentC = await loginAgent(app, userC);
    await agentC.post(JOURNALS).send(await sale(orgB, 12345));

    // Bypassing HTTP entirely: the org_id predicate lives in the query, not in
    // a middleware a future caller could skip.
    const forA = await trialBalance(orgA, null);
    const forB = await trialBalance(orgB, null);

    expect(forA.totalDebitCents).toBe(0);
    expect(forB.totalDebitCents).toBe(12345);
    expect(forA.isBalanced).toBe(true);
    expect(forB.isBalanced).toBe(true);
  });
});
