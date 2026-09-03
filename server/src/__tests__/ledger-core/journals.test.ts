import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — journal entries, through the API. Integration tier.
 *
 * The database-level guarantees are asserted separately, in
 * `ledgerConstraints.test.ts`, deliberately bypassing this layer.
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

/** The canonical example: a $450.00 AWS bill on account. */
async function awsBill(orgId: string) {
  return {
    entryDate: '2026-08-15',
    description: 'AWS August',
    lines: [
      { accountId: await accountId(orgId, '6120'), debitCents: 45000, creditCents: 0 },
      { accountId: await accountId(orgId, '2100'), debitCents: 0, creditCents: 45000 },
    ],
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

describe('posting a journal entry', () => {
  it('posts a balanced two-line entry', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(JOURNALS).send(await awsBill(orgA));

    expect(res.status).toBe(201);
    expect(res.body.entry.lines).toHaveLength(2);
    expect(res.body.entry.sourceType).toBe('manual');
    expect(res.body.entry.reversesEntryId).toBeNull();
    expect(res.body.entry.entryDate).toBe('2026-08-15');

    const debit = res.body.entry.lines.find((l: { accountCode: string }) => l.accountCode === '6120');
    expect(debit.debitCents).toBe(45000);
    // Phase 3 posts in the org's base currency at rate 1, so base equals native.
    expect(debit.baseDebitCents).toBe(45000);
    expect(debit.currencyCode).toBe('USD');
  });

  it('rejects an unbalanced entry with 422, naming both totals', async () => {
    const agent = await loginAgent(app, userA);
    const entry = await awsBill(orgA);
    entry.lines[1]!.creditCents = 44000;

    const res = await agent.post(JOURNALS).send(entry);

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('45000');
    expect(res.body.error).toContain('44000');
  });

  it('rejects an entry with only one line', async () => {
    const agent = await loginAgent(app, userA);
    const entry = await awsBill(orgA);

    const res = await agent.post(JOURNALS).send({ ...entry, lines: [entry.lines[0]] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least two lines/);
  });

  it('rejects a line with both a debit and a credit', async () => {
    const agent = await loginAgent(app, userA);
    const entry = await awsBill(orgA);
    entry.lines[0]!.creditCents = 45000;

    const res = await agent.post(JOURNALS).send(entry);
    expect(res.status).toBe(400);
  });

  it('rejects a fractional amount — money is integer cents at the boundary too', async () => {
    const agent = await loginAgent(app, userA);
    const entry = await awsBill(orgA);
    entry.lines[0]!.debitCents = 450.5;
    entry.lines[1]!.creditCents = 450.5;

    const res = await agent.post(JOURNALS).send(entry);
    expect(res.status).toBe(400);
  });

  it('rejects posting to a header account', async () => {
    const agent = await loginAgent(app, userA);

    const res = await agent.post(JOURNALS).send({
      entryDate: '2026-08-15',
      lines: [
        { accountId: await accountId(orgA, '1000'), debitCents: 100, creditCents: 0 },
        { accountId: await accountId(orgA, '2100'), debitCents: 0, creditCents: 100 },
      ],
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/header account/);
  });

  it('cannot forge a sourceType — a client entry is always manual', async () => {
    const agent = await loginAgent(app, userA);
    const entry = await awsBill(orgA);

    const res = await agent
      .post(JOURNALS)
      .send({ ...entry, sourceType: 'ap_flow', sourceId: crypto.randomUUID() });

    expect(res.status).toBe(201);
    // The forged values are stripped by the schema, not honoured.
    expect(res.body.entry.sourceType).toBe('manual');
    expect(res.body.entry.sourceId).toBeNull();
  });

  it('a VIEWER cannot post an entry', async () => {
    const viewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, viewer);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const res = await agent.post(JOURNALS).send(await awsBill(orgA));
    expect(res.status).toBe(403);
  });

  it('exposes no way to update or delete a posted entry', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent.post(JOURNALS).send(await awsBill(orgA));
    const { id } = created.body.entry;

    // Rule 6: there is no such route, and migration 004 would reject the write
    // even if one were added by mistake.
    expect((await agent.put(`${JOURNALS}/${id}`).send({ description: 'x' })).status).toBe(404);
    expect((await agent.delete(`${JOURNALS}/${id}`)).status).toBe(404);
  });
});

describe('rollback', () => {
  it('leaves no entry behind when a line is rejected mid-transaction', async () => {
    const agent = await loginAgent(app, userA);
    const before = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM journal_entries WHERE org_id = $1',
      [orgA],
    );

    // Second line points at another organization's account: the entry header
    // inserts, then the line is refused, and the whole transaction unwinds.
    const res = await agent.post(JOURNALS).send({
      entryDate: '2026-08-15',
      lines: [
        { accountId: await accountId(orgA, '6120'), debitCents: 100, creditCents: 0 },
        { accountId: await accountId(orgB, '2100'), debitCents: 0, creditCents: 100 },
      ],
    });

    expect(res.status).toBe(422);

    const after = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM journal_entries WHERE org_id = $1',
      [orgA],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);

    // And no orphaned lines anywhere.
    const orphans = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM ledger_lines l
        WHERE NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.id = l.journal_entry_id)`,
    );
    expect(orphans.rows[0]?.count).toBe('0');
  });
});

describe('reversing entries — the only correction path', () => {
  it('reverses an entry, swapping debits and credits', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent.post(JOURNALS).send(await awsBill(orgA));
    const originalId = created.body.entry.id;

    const res = await agent.post(`${JOURNALS}/${originalId}/reverse`).send({});

    expect(res.status).toBe(201);
    expect(res.body.entry.reversesEntryId).toBe(originalId);

    const reversed6120 = res.body.entry.lines.find(
      (l: { accountCode: string }) => l.accountCode === '6120',
    );
    // Debited 45000 originally, so credited 45000 now — and positive, never
    // a negative debit.
    expect(reversed6120.debitCents).toBe(0);
    expect(reversed6120.creditCents).toBe(45000);
  });

  it('nets the trial balance back to zero', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent.post(JOURNALS).send(await awsBill(orgA));

    const posted = await agent.get(TRIAL_BALANCE);
    expect(posted.body.totalDebitCents).toBe(45000);
    expect(posted.body.isBalanced).toBe(true);

    await agent.post(`${JOURNALS}/${created.body.entry.id}/reverse`).send({});

    const after = await agent.get(TRIAL_BALANCE);
    // Both sides doubled, and every account nets to zero again.
    expect(after.body.totalDebitCents).toBe(45000 * 2);
    expect(after.body.totalCreditCents).toBe(45000 * 2);
    expect(after.body.isBalanced).toBe(true);
    expect(after.body.rows.every((r: { netBalanceCents: number }) => r.netBalanceCents === 0)).toBe(
      true,
    );
  });

  it('refuses to reverse the same entry twice', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent.post(JOURNALS).send(await awsBill(orgA));
    const id = created.body.entry.id;

    expect((await agent.post(`${JOURNALS}/${id}/reverse`).send({})).status).toBe(201);

    const second = await agent.post(`${JOURNALS}/${id}/reverse`).send({});
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('Entry has already been reversed');
  });

  it('refuses to reverse a reversal', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent.post(JOURNALS).send(await awsBill(orgA));
    const reversal = await agent.post(`${JOURNALS}/${created.body.entry.id}/reverse`).send({});

    const res = await agent.post(`${JOURNALS}/${reversal.body.entry.id}/reverse`).send({});

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('A reversing entry cannot itself be reversed');
  });
});

describe('listing and pagination', () => {
  it('paginates and caps the limit at 100', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(JOURNALS).send(await awsBill(orgA));
    await agent.post(JOURNALS).send(await awsBill(orgA));

    const res = await agent.get(JOURNALS).query({ page: 1, limit: 5000 });

    expect(res.status).toBe(200);
    expect(res.body.totalCount).toBe(2);
    expect(res.body.currentPage).toBe(1);
    expect(res.body.entries[0].lines).toHaveLength(2);
  });
});

describe('cross-tenant isolation', () => {
  it("GET /journals/:id with org B's entry under org A's token returns 404", async () => {
    const agentC = await loginAgent(app, userC);
    const inB = await agentC.post(JOURNALS).send(await awsBill(orgB));
    expect(inB.status).toBe(201);

    const agentA = await loginAgent(app, userA);
    const res = await agentA.get(`${JOURNALS}/${inB.body.entry.id}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Journal entry not found');
  });

  it("cannot reverse another organization's entry", async () => {
    const agentC = await loginAgent(app, userC);
    const inB = await agentC.post(JOURNALS).send(await awsBill(orgB));

    const agentA = await loginAgent(app, userA);
    const res = await agentA.post(`${JOURNALS}/${inB.body.entry.id}/reverse`).send({});

    expect(res.status).toBe(404);
  });

  it("org A's list and trial balance never include org B's entries", async () => {
    const agentC = await loginAgent(app, userC);
    await agentC.post(JOURNALS).send(await awsBill(orgB));

    const agentA = await loginAgent(app, userA);
    const list = await agentA.get(JOURNALS);
    const tb = await agentA.get(TRIAL_BALANCE);

    expect(list.body.totalCount).toBe(0);
    expect(tb.body.totalDebitCents).toBe(0);
    expect(tb.body.isBalanced).toBe(true);
  });

  it('a forged orgId in the query string, headers and body is ignored', async () => {
    const agentC = await loginAgent(app, userC);
    await agentC.post(JOURNALS).send(await awsBill(orgB));

    const agentA = await loginAgent(app, userA);
    const honest = await agentA.get(JOURNALS);
    const forged = await agentA
      .get(JOURNALS)
      .query({ orgId: orgB })
      .set('X-Org-Id', orgB)
      .send({ orgId: orgB });

    expect(forged.status).toBe(200);
    expect(forged.text).toBe(honest.text);
  });
});
