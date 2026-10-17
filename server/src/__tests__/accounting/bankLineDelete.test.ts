import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Accounting — bank statement line deletion, restore and history (Phase 46e).
 * Integration tier, real PostgreSQL. Includes this feature's own cross-tenant
 * isolation case (rule 15).
 */

const app = createApp();
const BANK_IMPORTS = '/api/v1/bank-imports';
const BANK_TRANSACTIONS = '/api/v1/bank-transactions';
const RECONCILIATION = '/api/v1/reports/bank-reconciliation';
const AS_OF = '2026-06-30';

type Agent = Awaited<ReturnType<typeof loginAgent>>;
let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let agentA: Agent;
let cashAccountId: string;
let feeAccountId: string;

async function accountId(org: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [org, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${org}`);
  return row.id;
}

function csv(lines: Array<[string, string, number]>): string {
  return `Date,Description,Amount\n${lines.map(([d, desc, c]) => `${d},${desc},${(c / 100).toFixed(2)}`).join('\n')}`;
}

async function importLines(
  agent: Agent,
  lines: Array<[string, string, number]>,
  accId: string = cashAccountId,
): Promise<{ importId: string; body: Record<string, unknown>; ids: Record<string, string> }> {
  const res = await agent.post(BANK_IMPORTS).send({
    accountId: accId,
    fileName: 'lines.csv',
    content: csv(lines),
    dateFormat: 'ISO',
  });
  if (res.status !== 201) throw new Error(`fixture: import failed ${res.status} ${JSON.stringify(res.body)}`);
  const listRes = await agent.get(`${BANK_TRANSACTIONS}?accountId=${accId}&limit=100`);
  const transactions = listRes.body.transactions as Array<{ id: string; description: string }>;
  const ids: Record<string, string> = {};
  for (const t of transactions) ids[t.description] = t.id;
  return { importId: res.body.import.id as string, body: res.body as Record<string, unknown>, ids };
}

function idOf(ids: Record<string, string>, description: string): string {
  const id = ids[description];
  if (id === undefined) throw new Error(`fixture: no line ${description}`);
  return id;
}

async function deleteLines(agent: Agent, ids: string[], reason: string | null = null) {
  return agent.post(`${BANK_TRANSACTIONS}/delete`).send({ ids, reason });
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'bankdel-a', orgName: 'Bank Delete Org A' });
  userB = await createUserWithOrg({ label: 'bankdel-b', orgName: 'Bank Delete Org B' });
  orgA = userA.orgId;
  agentA = await loginAgent(app, userA);
  cashAccountId = await accountId(orgA, '1110');
  feeAccountId = await accountId(orgA, '6600');
});

afterAll(closePool);

describe('deleting bank lines', () => {
  it('deletes an unmatched line', async () => {
    const { ids } = await importLines(agentA, [['2026-06-01', 'Dup', -1000]]);
    const id = idOf(ids, 'Dup');

    const res = await deleteLines(agentA, [id], 'Duplicate');
    expect(res.status).toBe(200);
    expect(res.body.deletedCount).toBe(1);

    const get = await agentA.get(`${BANK_TRANSACTIONS}/${id}`);
    expect(get.body.transaction.status).toBe('DELETED');
    expect(get.body.transaction.deleteReason).toBe('Duplicate');
    expect(get.body.transaction.deletedByName).toBeTruthy();
  });

  it('is hidden from the default list and shown under status=DELETED', async () => {
    const { ids } = await importLines(agentA, [['2026-06-01', 'Gone', -1000], ['2026-06-02', 'Kept', -2000]]);
    const id = idOf(ids, 'Gone');
    await deleteLines(agentA, [id]);

    const all = await agentA.get(`${BANK_TRANSACTIONS}?accountId=${cashAccountId}&limit=100`);
    const allIds = (all.body.transactions as Array<{ id: string }>).map((t) => t.id);
    expect(allIds).not.toContain(id);
    expect(allIds).toContain(idOf(ids, 'Kept'));

    const deleted = await agentA.get(`${BANK_TRANSACTIONS}?accountId=${cashAccountId}&status=DELETED&limit=100`);
    expect((deleted.body.transactions as Array<{ id: string }>).map((t) => t.id)).toEqual([id]);
  });

  it('refuses a matched line', async () => {
    const { ids } = await importLines(agentA, [['2026-06-01', 'Fee', -1000]]);
    const id = idOf(ids, 'Fee');
    const post = await agentA.post(`${BANK_TRANSACTIONS}/${id}/post-journal`).send({ accountId: feeAccountId, description: null });
    expect(post.status).toBe(200);

    const res = await deleteLines(agentA, [id]);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Only unreconciled lines can be deleted — unmatch or unignore first');

    const get = await agentA.get(`${BANK_TRANSACTIONS}/${id}`);
    expect(get.body.transaction.status).toBe('MATCHED');
  });
});

describe('restore', () => {
  it('restores a deleted line, then refuses a second restore', async () => {
    const { ids } = await importLines(agentA, [['2026-06-01', 'Oops', -1000]]);
    const id = idOf(ids, 'Oops');
    await deleteLines(agentA, [id], 'Mistake');

    const res = await agentA.post(`${BANK_TRANSACTIONS}/${id}/restore`).send({});
    expect(res.status).toBe(200);
    expect(res.body.transaction.status).toBe('UNMATCHED');
    expect(res.body.transaction.deletedAt).toBeNull();
    expect(res.body.transaction.deletedBy).toBeNull();
    expect(res.body.transaction.deleteReason).toBeNull();

    const again = await agentA.post(`${BANK_TRANSACTIONS}/${id}/restore`).send({});
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('This bank line is not deleted');
  });

  it('unignore cannot restore a deleted line', async () => {
    const { ids } = await importLines(agentA, [['2026-06-01', 'Del', -1000]]);
    const id = idOf(ids, 'Del');
    await deleteLines(agentA, [id]);

    const res = await agentA.post(`${BANK_TRANSACTIONS}/${id}/unignore`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('This bank line is not ignored');
  });
});

describe('re-import and reconciliation', () => {
  it('reports previously deleted lines on re-import', async () => {
    const lines: Array<[string, string, number]> = [['2026-06-01', 'Once', -1000]];
    const first = await importLines(agentA, lines);
    await deleteLines(agentA, [idOf(first.ids, 'Once')]);

    const res = await agentA.post(BANK_IMPORTS).send({
      accountId: cashAccountId,
      fileName: 'again.csv',
      content: csv(lines),
      dateFormat: 'ISO',
    });
    expect(res.status).toBe(201);
    expect(res.body.importedCount).toBe(0);
    expect(res.body.duplicateCount).toBe(1);
    expect(res.body.previouslyDeletedCount).toBe(1);
  });

  it('the reconciliation report excludes deleted lines', async () => {
    await importLines(agentA, [['2026-06-01', 'Base', 5000]]);
    const before = await agentA.get(`${RECONCILIATION}?accountId=${cashAccountId}&asOf=${AS_OF}`);
    const baseline = before.body.statementBalanceCents as number;
    expect(baseline).toBe(5000);

    const second = await importLines(agentA, [['2026-06-02', 'Minus', -3800]]);
    const mid = await agentA.get(`${RECONCILIATION}?accountId=${cashAccountId}&asOf=${AS_OF}`);
    expect(mid.body.statementBalanceCents).toBe(1200);

    await deleteLines(agentA, [idOf(second.ids, 'Minus')]);
    const after = await agentA.get(`${RECONCILIATION}?accountId=${cashAccountId}&asOf=${AS_OF}`);
    expect(after.body.statementBalanceCents).toBe(baseline);
    expect(after.body.deletedCount).toBe(1);
  });
});

describe('deleting a whole import', () => {
  it('deletes all unmatched lines, and refuses once a line is matched', async () => {
    const first = await importLines(agentA, [
      ['2026-06-01', 'A1', -100],
      ['2026-06-02', 'A2', -200],
      ['2026-06-03', 'A3', -300],
    ]);
    const res = await agentA.post(`${BANK_IMPORTS}/${first.importId}/delete`).send({ reason: null });
    expect(res.status).toBe(200);
    expect(res.body.deletedCount).toBe(3);

    const second = await importLines(agentA, [
      ['2026-07-01', 'B1', -400],
      ['2026-07-02', 'B2', -500],
    ]);
    const post = await agentA
      .post(`${BANK_TRANSACTIONS}/${idOf(second.ids, 'B1')}/post-journal`)
      .send({ accountId: feeAccountId, description: null });
    expect(post.status).toBe(200);

    const refused = await agentA.post(`${BANK_IMPORTS}/${second.importId}/delete`).send({ reason: null });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('This statement has reconciled or ignored lines — unmatch or unignore them first');
    const still = await agentA.get(`${BANK_TRANSACTIONS}/${idOf(second.ids, 'B2')}`);
    expect(still.body.transaction.status).toBe('UNMATCHED');
  });
});

describe('history', () => {
  it('records delete, restore and match newest first, with IMPORTED on the line itself', async () => {
    const { ids } = await importLines(agentA, [['2026-06-01', 'Hist', -1000]]);
    const id = idOf(ids, 'Hist');
    await deleteLines(agentA, [id], 'Oops');
    await agentA.post(`${BANK_TRANSACTIONS}/${id}/restore`).send({});
    const post = await agentA.post(`${BANK_TRANSACTIONS}/${id}/post-journal`).send({ accountId: feeAccountId, description: null });
    expect(post.status).toBe(200);

    const account = await agentA.get(`${BANK_TRANSACTIONS}/history?accountId=${cashAccountId}`);
    expect(account.status).toBe(200);
    const actions = (account.body.entries as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toEqual(['MATCHED', 'RESTORED', 'DELETED']);

    const line = await agentA.get(`${BANK_TRANSACTIONS}/${id}/history`);
    expect(line.status).toBe(200);
    const lineActions = (line.body.history as Array<{ action: string }>).map((e) => e.action);
    expect(lineActions.slice(0, 3)).toEqual(['MATCHED', 'RESTORED', 'DELETED']);
    expect(lineActions[lineActions.length - 1]).toBe('IMPORTED');
  });

  it('unmatch keeps what the line was matched to', async () => {
    const { ids } = await importLines(agentA, [['2026-06-01', 'Fee', -3800]]);
    const id = idOf(ids, 'Fee');
    const post = await agentA.post(`${BANK_TRANSACTIONS}/${id}/post-journal`).send({ accountId: feeAccountId, description: null });
    const entryId = post.body.transaction.matchedJournalEntryId as string;
    const un = await agentA.post(`${BANK_TRANSACTIONS}/${id}/unmatch`).send({});
    expect(un.status).toBe(200);

    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM journal_entries WHERE org_id = $1 AND reverses_entry_id = $2',
      [orgA, entryId],
    );
    expect(rows).toHaveLength(1);

    const hist = await agentA.get(`${BANK_TRANSACTIONS}/${id}/history`);
    const event = (hist.body.history as Array<{ action: string; details: Record<string, unknown> | null }>).find(
      (e) => e.action === 'UNMATCHED',
    );
    expect(event?.details?.previousJournalEntryId).toBe(entryId);
  });
});

describe('isolation and immutability', () => {
  it('cross-tenant: org B cannot delete, restore or read history of an org A line', async () => {
    const { ids } = await importLines(agentA, [['2026-06-01', 'Secret', -1000]]);
    const id = idOf(ids, 'Secret');
    const agentB = await loginAgent(app, userB);

    expect((await deleteLines(agentB, [id])).status).toBe(404);
    expect((await agentB.post(`${BANK_TRANSACTIONS}/${id}/restore`).send({})).status).toBe(404);
    expect((await agentB.get(`${BANK_TRANSACTIONS}/${id}/history`)).status).toBe(404);

    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM bank_transactions WHERE id = $1 AND org_id = $2',
      [id, orgA],
    );
    expect(rows[0]?.status).toBe('UNMATCHED');
  });

  it('a hard DELETE is still refused by the trigger', async () => {
    const { ids } = await importLines(agentA, [['2026-06-01', 'Hard', -1000]]);
    await expect(
      pool.query('DELETE FROM bank_transactions WHERE id = $1', [idOf(ids, 'Hard')]),
    ).rejects.toMatchObject({ code: '0A000' });
  });

  it('the trigger carve-out is narrow: other columns stay immutable', async () => {
    const { ids } = await importLines(agentA, [['2026-06-01', 'Narrow', -1000]]);
    await expect(
      pool.query("UPDATE bank_transactions SET description = 'x' WHERE id = $1", [idOf(ids, 'Narrow')]),
    ).rejects.toMatchObject({ code: '0A000' });
  });
});
