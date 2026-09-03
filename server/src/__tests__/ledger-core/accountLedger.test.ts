import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — the account ledger. Integration tier.
 *
 * A postable account's transaction history with a running balance, computed
 * server-side by a window function over the whole filtered set (see
 * study/postgresql/window-functions-and-running-totals.md).
 */

const app = createApp();
const JOURNALS = '/api/v1/ledger-core/journals';

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

function ledgerUrl(id: string): string {
  return `/api/v1/ledger-core/accounts/${id}/ledger`;
}

/** Three entries on 6120/2100: $100.00 (06-10), $250.00 (07-15), $450.00 (08-20). */
async function threePurchases(orgId: string) {
  const account6120 = await accountId(orgId, '6120');
  const account2100 = await accountId(orgId, '2100');

  const amounts: [string, number][] = [
    ['2026-06-10', 10000],
    ['2026-07-15', 25000],
    ['2026-08-20', 45000],
  ];

  for (const [entryDate, amountCents] of amounts) {
    await pool.query(
      `WITH e AS (
         INSERT INTO journal_entries (org_id, created_by, entry_date, description, source_type)
         SELECT $1, u.id, $2, $3, 'manual'
           FROM organization_members om JOIN users u ON u.id = om.user_id
          WHERE om.org_id = $1 LIMIT 1
         RETURNING id
       )
       INSERT INTO ledger_lines
         (org_id, journal_entry_id, account_id, debit_cents, credit_cents, currency_code, fx_rate, base_debit_cents, base_credit_cents)
       SELECT $1, e.id, v.account_id, v.debit_cents, v.credit_cents, 'USD', 1, v.debit_cents, v.credit_cents
         FROM e, (VALUES ($4::uuid, $6::bigint, 0::bigint), ($5::uuid, 0::bigint, $6::bigint))
              AS v(account_id, debit_cents, credit_cents)`,
      [orgId, entryDate, `Purchase ${String(amountCents)}`, account6120, account2100, amountCents],
    );
  }
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userC = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userC.orgId;
});

afterAll(closePool);

describe('account ledger', () => {
  it('returns every line oldest first', async () => {
    await threePurchases(orgA);
    const agent = await loginAgent(app, userA);
    const account6120 = await accountId(orgA, '6120');

    const res = await agent.get(ledgerUrl(account6120));

    expect(res.status).toBe(200);
    expect(res.body.rows.map((r: { entryDate: string }) => r.entryDate)).toEqual([
      '2026-06-10',
      '2026-07-15',
      '2026-08-20',
    ]);
  });

  it('the running balance accumulates', async () => {
    await threePurchases(orgA);
    const agent = await loginAgent(app, userA);
    const account6120 = await accountId(orgA, '6120');

    const res = await agent.get(ledgerUrl(account6120));

    expect(res.body.rows.map((r: { runningBalanceCents: number }) => r.runningBalanceCents)).toEqual([
      10000, 35000, 80000,
    ]);
  });

  it('closing equals opening plus movement', async () => {
    await threePurchases(orgA);
    const agent = await loginAgent(app, userA);
    const account6120 = await accountId(orgA, '6120');

    const res = await agent.get(ledgerUrl(account6120));

    expect(res.body.closingBalanceCents).toBe(80000);
    expect(res.body.periodDebitCents).toBe(80000);
    expect(res.body.periodCreditCents).toBe(0);
  });

  it('?from= produces a non-zero opening balance', async () => {
    await threePurchases(orgA);
    const agent = await loginAgent(app, userA);
    const account6120 = await accountId(orgA, '6120');

    const res = await agent.get(ledgerUrl(account6120)).query({ from: '2026-07-01' });

    expect(res.body.openingBalanceCents).toBe(10000);
    expect(res.body.rows[0].runningBalanceCents).toBe(35000);
    expect(res.body.closingBalanceCents).toBe(80000);
  });

  it('a credit-balance account is credit-positive', async () => {
    await threePurchases(orgA);
    const agent = await loginAgent(app, userA);
    const account2100 = await accountId(orgA, '2100');

    const res = await agent.get(ledgerUrl(account2100));

    expect(res.body.rows.map((r: { runningBalanceCents: number }) => r.runningBalanceCents)).toEqual([
      10000, 35000, 80000,
    ]);
  });

  it('the running balance continues across pages', async () => {
    await threePurchases(orgA);
    const agent = await loginAgent(app, userA);
    const account6120 = await accountId(orgA, '6120');

    const res = await agent.get(ledgerUrl(account6120)).query({ limit: 2, page: 2 });

    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].runningBalanceCents).toBe(80000);
  });

  it('counterparts name the other side', async () => {
    await threePurchases(orgA);
    const agent = await loginAgent(app, userA);
    const account6120 = await accountId(orgA, '6120');

    const res = await agent.get(ledgerUrl(account6120));

    for (const r of res.body.rows as { counterparts: string[] }[]) {
      expect(r.counterparts.some((c) => c.startsWith('2100 '))).toBe(true);
    }
  });

  it('a reversal moves the balance back', async () => {
    await threePurchases(orgA);
    const agent = await loginAgent(app, userA);
    const account6120 = await accountId(orgA, '6120');

    const entries = await agent.get(JOURNALS).query({ limit: 100 });
    const august = (entries.body.entries as { id: string; entryDate: string }[]).find(
      (e) => e.entryDate === '2026-08-20',
    );
    if (august === undefined) throw new Error('fixture: august entry not found');
    await agent.post(`${JOURNALS}/${august.id}/reverse`).send({});

    const res = await agent.get(ledgerUrl(account6120));

    expect(res.body.closingBalanceCents).toBe(35000);
  });

  it('a header account is refused', async () => {
    const agent = await loginAgent(app, userA);
    const header = await accountId(orgA, '6000');

    const res = await agent.get(ledgerUrl(header));

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Account 6000 is a header account and has no ledger of its own');
  });

  it('an unposted account returns an empty ledger', async () => {
    const agent = await loginAgent(app, userA);
    const account6120 = await accountId(orgA, '6120');

    const res = await agent.get(ledgerUrl(account6120));

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(0);
    expect(res.body.openingBalanceCents).toBe(0);
    expect(res.body.closingBalanceCents).toBe(0);
  });

  it('?from=nonsense is rejected', async () => {
    const agent = await loginAgent(app, userA);
    const account6120 = await accountId(orgA, '6120');

    const res = await agent.get(ledgerUrl(account6120)).query({ from: 'nonsense' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('from must be a date in YYYY-MM-DD format');
  });

  describe('cross-tenant isolation', () => {
    it("org B requesting org A's account id gets 404, never 403", async () => {
      await threePurchases(orgA);
      const account6120 = await accountId(orgA, '6120');
      const agentC = await loginAgent(app, userC);

      const res = await agentC.get(ledgerUrl(account6120));

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Account not found');
    });

    it("org A's ledger totals count only org A's entries", async () => {
      await threePurchases(orgA);
      await threePurchases(orgB);

      const agentA = await loginAgent(app, userA);
      const account6120 = await accountId(orgA, '6120');
      const res = await agentA.get(ledgerUrl(account6120));

      expect(res.body.closingBalanceCents).toBe(80000);
      expect(res.body.rows).toHaveLength(3);
    });
  });
});
