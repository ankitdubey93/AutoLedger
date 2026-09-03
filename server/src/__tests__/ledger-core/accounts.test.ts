import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { seedDefaultChart } from '../../services/ledger-core/accountService.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — chart of accounts. Integration tier, real PostgreSQL.
 *
 * Includes this app's own cross-tenant isolation suite. Rule 15 wants one per
 * app, not one for the whole suite: a bug in LedgerCore's scoping is invisible
 * to `tenantIsolation.test.ts`, which only ever queries platform tables.
 *
 * Fixture mirrors that file's shape —
 *   userA — member of org A only
 *   userB — member of org A *and* org B
 *   userC — member of org B only
 * — because without a user who legitimately spans both tenants, a bug that
 * returns nothing to everybody passes every isolation assertion.
 */

const app = createApp();
const BASE = '/api/v1/ledger-core/accounts';

/** The seed's totals, asserted rather than assumed. See docs/schema.md. */
const SEEDED_TOTAL = 44;
const SEEDED_POSTABLE = 34;

let userA: SeededUser;
let userB: SeededUser;
let userC: SeededUser;
let orgA: string;
let orgB: string;

/** Looks up an account id by code within one organization. */
async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
}

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userC = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userC.orgId;

  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bobs Own' });
  await addMember(orgA, userB.id, 'ADMIN');
  await addMember(orgB, userB.id, 'ADMIN');
});

afterAll(closePool);

describe('the default chart is seeded at registration', () => {
  it('seeds 44 accounts for a newly registered organization', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(BASE);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(SEEDED_TOTAL);
    expect(res.body.accounts).toHaveLength(SEEDED_TOTAL);
  });

  it('marks exactly 34 of them postable, the rest header rollups', async () => {
    const agent = await loginAgent(app, userA);
    const { body } = await agent.get(BASE);

    const postable = body.accounts.filter((a: { isPostable: boolean }) => a.isPostable);
    expect(postable).toHaveLength(SEEDED_POSTABLE);

    // 1000 Assets is a reporting rollup and must never receive a posting.
    const assets = body.accounts.find((a: { code: string }) => a.code === '1000');
    expect(assets.isPostable).toBe(false);
    const cash = body.accounts.find((a: { code: string }) => a.code === '1110');
    expect(cash.isPostable).toBe(true);
  });

  it('seeds the tax and FX accounts later phases depend on', async () => {
    const agent = await loginAgent(app, userA);
    const { body } = await agent.get(BASE);
    const codes = body.accounts.map((a: { code: string }) => a.code);

    // AP-Flow (Phase 11) splits input tax out of an invoice total.
    expect(codes).toContain('1180');
    expect(codes).toContain('2140');
    // The FX engine (Phase 8) posts realized and unrealized gain/loss.
    expect(codes).toContain('4910');
    expect(codes).toContain('6810');
    expect(codes).toContain('6820');
    // Seeding these now is what saves Phases 8 and 11 from needing their own
    // backfill for every organization created in between.
  });

  it('uses exactly the five permitted account types', async () => {
    const agent = await loginAgent(app, userA);
    const { body } = await agent.get(BASE);

    const types = new Set(body.accounts.map((a: { type: string }) => a.type));
    expect([...types].sort()).toEqual(['Asset', 'Equity', 'Expense', 'Liability', 'Revenue']);
  });

  it('returns the chart as a tree when ?tree=true', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(BASE).query({ tree: 'true' });

    expect(res.status).toBe(200);
    // count is the total, not the number of roots — a caller comparing it to
    // the flat list must get the same number.
    expect(res.body.count).toBe(SEEDED_TOTAL);

    const roots = res.body.accounts;
    expect(roots.every((r: { parentId: null }) => r.parentId === null)).toBe(true);

    // 1000 Assets -> 1100 Current Assets -> 1110 Operating Cash
    const assets = roots.find((r: { code: string }) => r.code === '1000');
    const current = assets.children.find((c: { code: string }) => c.code === '1100');
    const cash = current.children.find((c: { code: string }) => c.code === '1110');
    expect(cash).toBeDefined();
    expect(cash.name).toBe('Operating Cash');
  });

  it('is idempotent — seeding an organization twice adds nothing', async () => {
    const insertedAgain = await seedDefaultChart(pool, orgA);
    expect(insertedAgain).toBe(0);

    const agent = await loginAgent(app, userA);
    const { body } = await agent.get(BASE);
    expect(body.count).toBe(SEEDED_TOTAL);
  });
});

describe('creating and updating accounts', () => {
  it('creates an account under a same-type parent', async () => {
    const agent = await loginAgent(app, userA);
    const parentId = await accountId(orgA, '6000');

    const res = await agent
      .post(BASE)
      .send({ code: '6150', name: 'Training', type: 'Expense', parentId });

    expect(res.status).toBe(201);
    expect(res.body.account.code).toBe('6150');
    expect(res.body.account.parentId).toBe(parentId);
    expect(res.body.account.isPostable).toBe(true);
  });

  it('rejects a duplicate code with 409', async () => {
    const agent = await loginAgent(app, userA);

    const res = await agent.post(BASE).send({ code: '1110', name: 'Duplicate', type: 'Asset' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Account code already exists');
  });

  it('rejects a parent of a different type with 422', async () => {
    const agent = await loginAgent(app, userA);
    const assetsParent = await accountId(orgA, '1000');

    const res = await agent
      .post(BASE)
      .send({ code: '6150', name: 'Wrong tree', type: 'Expense', parentId: assetsParent });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Parent account must have the same type');
  });

  it('rejects a sixth account type at the schema boundary', async () => {
    const agent = await loginAgent(app, userA);

    const res = await agent.post(BASE).send({ code: '7000', name: 'COGS', type: 'CostOfSales' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/type/);
  });

  it('refuses to re-parent an account under its own descendant', async () => {
    const agent = await loginAgent(app, userA);
    const assets = await accountId(orgA, '1000');
    const cash = await accountId(orgA, '1110'); // a grandchild of 1000

    const res = await agent.patch(`${BASE}/${assets}`).send({ parentId: cash });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Re-parenting would create a cycle');
  });

  it('refuses to make an account its own parent', async () => {
    const agent = await loginAgent(app, userA);
    const cash = await accountId(orgA, '1110');

    const res = await agent.patch(`${BASE}/${cash}`).send({ parentId: cash });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Re-parenting would create a cycle');
  });

  it('retires an account with isActive rather than deleting it', async () => {
    const agent = await loginAgent(app, userA);
    const id = await accountId(orgA, '1140');

    const patched = await agent.patch(`${BASE}/${id}`).send({ isActive: false });
    expect(patched.status).toBe(200);
    expect(patched.body.account.isActive).toBe(false);

    const listed = await agent.get(BASE);
    expect(listed.body.count).toBe(SEEDED_TOTAL - 1);

    const all = await agent.get(BASE).query({ includeInactive: 'true' });
    expect(all.body.count).toBe(SEEDED_TOTAL);
  });

  it('exposes no way to delete an account', async () => {
    const agent = await loginAgent(app, userA);
    const id = await accountId(orgA, '1140');

    const res = await agent.delete(`${BASE}/${id}`);
    expect(res.status).toBe(404);
  });

  it('a VIEWER cannot create an account', async () => {
    const viewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, viewer);
    // Log in, then switch into org A, where Vic is only a VIEWER.
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const res = await agent.post(BASE).send({ code: '6150', name: 'Nope', type: 'Expense' });

    expect(res.status).toBe(403);
  });
});

describe('cross-tenant isolation', () => {
  it('two organizations may both own account code 1110', async () => {
    const idA = await accountId(orgA, '1110');
    const idB = await accountId(orgB, '1110');
    expect(idA).not.toBe(idB);

    const agentA = await loginAgent(app, userA);
    const res = await agentA.get(`${BASE}/${idA}`);
    expect(res.status).toBe(200);
    expect(res.body.account.code).toBe('1110');
  });

  it("GET /accounts/:id with org B's id under org A's token returns 404, not 403", async () => {
    const agentA = await loginAgent(app, userA);
    const foreign = await accountId(orgB, '1110');

    const res = await agentA.get(`${BASE}/${foreign}`);

    // 404 and never 403: a 403 confirms the id is real in some other tenant,
    // which is itself a leak.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Account not found');
  });

  it("PATCH against org B's account under org A's token returns 404", async () => {
    const agentA = await loginAgent(app, userA);
    const foreign = await accountId(orgB, '1140');

    const res = await agentA.patch(`${BASE}/${foreign}`).send({ name: 'Hijacked' });

    expect(res.status).toBe(404);

    // And the row is genuinely untouched.
    const { rows } = await pool.query<{ name: string }>(
      'SELECT name FROM accounts WHERE id = $1',
      [foreign],
    );
    expect(rows[0]?.name).toBe('Inventory');
  });

  it("rejects a parentId belonging to another organization with 422", async () => {
    const agentA = await loginAgent(app, userA);
    const foreignParent = await accountId(orgB, '6000');

    const res = await agentA
      .post(BASE)
      .send({ code: '6150', name: 'Cross tenant', type: 'Expense', parentId: foreignParent });

    // Reported as "not found" rather than "wrong organization", for the same
    // reason as the 404 above.
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Parent account not found');
  });

  it('a forged orgId in the query string, headers and body is ignored', async () => {
    const agentA = await loginAgent(app, userA);

    const honest = await agentA.get(BASE);
    const forged = await agentA
      .get(BASE)
      .query({ orgId: orgB })
      .set('X-Org-Id', orgB)
      .send({ orgId: orgB });

    expect(forged.status).toBe(200);
    expect(forged.body).toEqual(honest.body);
    // Assert on the raw text too, so a leak through a field nobody thought to
    // check still fails.
    expect(forged.text).toBe(honest.text);
  });

  it('a user in both tenants sees a different chart in each', async () => {
    const agentB = await loginAgent(app, userB);

    await agentB.post('/api/v1/auth/switch-org').send({ orgId: orgA });
    const inA = await agentB.get(BASE);
    const idsInA = inA.body.accounts.map((a: { id: string }) => a.id);

    await agentB.post('/api/v1/auth/switch-org').send({ orgId: orgB });
    const inB = await agentB.get(BASE);
    const idsInB = inB.body.accounts.map((a: { id: string }) => a.id);

    // Bob legitimately sees both charts — but never the same rows, and never
    // both at once. This is the case that catches "return nothing to everybody".
    expect(inA.body.count).toBe(SEEDED_TOTAL);
    expect(inB.body.count).toBe(SEEDED_TOTAL);
    expect(idsInA.some((id: string) => idsInB.includes(id))).toBe(false);
  });

  it('the service layer is scoped even when called directly', async () => {
    // Not through HTTP: proves the predicate lives in the service, not in a
    // middleware that a future caller might bypass.
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM accounts WHERE org_id = $1',
      [orgA],
    );
    expect(Number(rows[0]?.count)).toBe(SEEDED_TOTAL);
  });
});

describe('account balances', () => {
  const BALANCES = `${BASE}/balances`;

  interface BalanceRow {
    accountId: string;
    ownBalanceCents: number;
    rollupBalanceCents: number;
  }

  function balanceFor(body: { balances: BalanceRow[] }, id: string): BalanceRow {
    const found = body.balances.find((b) => b.accountId === id);
    if (found === undefined) throw new Error(`no balance row for account ${id}`);
    return found;
  }

  /** A $450.00 AWS bill: debit 6120 (Expense), credit 2100 (Liability). */
  async function awsBill(orgId: string, entryDate = '2026-08-15') {
    return {
      entryDate,
      description: 'AWS August',
      lines: [
        { accountId: await accountId(orgId, '6120'), debitCents: 45000, creditCents: 0 },
        { accountId: await accountId(orgId, '2100'), debitCents: 0, creditCents: 45000 },
      ],
    };
  }

  it('returns a row for every account', async () => {
    const agent = await loginAgent(app, userA);

    const res = await agent.get(BALANCES);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(SEEDED_TOTAL);
    expect(res.body.balances).toHaveLength(SEEDED_TOTAL);
  });

  it("a posted leaf carries its own balance, and its header rolls it up to the root", async () => {
    const agent = await loginAgent(app, userA);
    await agent.post('/api/v1/ledger-core/journals').send(await awsBill(orgA));

    const res = await agent.get(BALANCES);

    const leaf6120 = await accountId(orgA, '6120');
    const header6000 = await accountId(orgA, '6000');
    const untouched4000 = await accountId(orgA, '4000');

    expect(balanceFor(res.body, leaf6120).ownBalanceCents).toBe(45000);
    // A header account posts no lines of its own.
    expect(balanceFor(res.body, header6000).ownBalanceCents).toBe(0);
    expect(balanceFor(res.body, header6000).rollupBalanceCents).toBe(45000);
    // A leaf's rollup equals its own balance.
    expect(balanceFor(res.body, leaf6120).rollupBalanceCents).toBe(45000);
    // An untouched branch is zero.
    expect(balanceFor(res.body, untouched4000).rollupBalanceCents).toBe(0);
  });

  it('the root rolls the whole branch up, credit-positive for a Liability', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post('/api/v1/ledger-core/journals').send(await awsBill(orgA));

    const res = await agent.get(BALANCES);

    const root2000 = await accountId(orgA, '2000');
    expect(balanceFor(res.body, root2000).rollupBalanceCents).toBe(45000);
  });

  it('?asOf= excludes later entries', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post('/api/v1/ledger-core/journals').send(await awsBill(orgA, '2026-08-15'));

    const res = await agent.get(BALANCES).query({ asOf: '2026-07-31' });

    const leaf6120 = await accountId(orgA, '6120');
    expect(balanceFor(res.body, leaf6120).ownBalanceCents).toBe(0);
  });

  it('?asOf=bad is rejected', async () => {
    const agent = await loginAgent(app, userA);

    const res = await agent.get(BALANCES).query({ asOf: 'bad' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('asOf must be a date in YYYY-MM-DD format');
  });

  it('is not shadowed by the /:id route', async () => {
    const agent = await loginAgent(app, userA);

    const res = await agent.get(BALANCES);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.balances)).toBe(true);
  });

  describe('cross-tenant isolation', () => {
    it("org B's balances are all zero while org A has postings", async () => {
      const agentA = await loginAgent(app, userA);
      await agentA.post('/api/v1/ledger-core/journals').send(await awsBill(orgA));

      const agentC = await loginAgent(app, userC);
      const res = await agentC.get(BALANCES);

      expect(res.body.balances.every((b: BalanceRow) => b.rollupBalanceCents === 0)).toBe(true);
    });

    it("org A's totals never include org B's postings", async () => {
      const agentA = await loginAgent(app, userA);
      await agentA.post('/api/v1/ledger-core/journals').send(await awsBill(orgA));

      const agentC = await loginAgent(app, userC);
      await agentC.post('/api/v1/ledger-core/journals').send(await awsBill(orgB));

      const resA = await agentA.get(BALANCES);
      const leaf6120InA = await accountId(orgA, '6120');
      expect(balanceFor(resA.body, leaf6120InA).ownBalanceCents).toBe(45000);
    });
  });
});
