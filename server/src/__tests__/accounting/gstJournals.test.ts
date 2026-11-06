import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId } from '../helpers/accountingFixtures.js';

/**
 * GST on money that moves without a document (Phase 49c). Integration tier.
 *
 * The central claims: GST comes out of the gross and the entry still balances;
 * the detail row records what the BAS needs, and a refund is signed against the
 * code's normal side; no code means no GST; a reversal leaves the detail alone
 * and is linked through reverses_entry_id; and a generic organization refuses.
 */

const app = createApp();
const ACTIVATE = {
  gst: { registered: true, basis: 'ACCRUAL', basCycle: 'QUARTERLY', basMethod: 'FULL' },
  timezone: 'Australia/Sydney',
};

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let userB: SeededUser;
let agentA: Agent;
let agentB: Agent;

async function importLines(agent: Agent, orgId: string, rows: [string, string, number][]): Promise<string[]> {
  const bank = await accountId(orgId, '1110');
  const csv = ['Date,Description,Amount', ...rows.map(([d, m, a]) => `${d},${m},${(a / 100).toFixed(2)}`)].join('\n');
  const res = await agent.post('/api/v1/bank-imports').send({ accountId: bank, fileName: `s-${String(Math.random())}.csv`, content: csv });
  if (res.status !== 201) throw new Error(`fixture: import failed ${res.status} ${res.text}`);
  const list = await agent.get('/api/v1/bank-transactions');
  return rows.map(([, memo]) => {
    const found = (list.body.transactions as { id: string; description: string }[]).find((t) => t.description === memo);
    if (found === undefined) throw new Error(`fixture: no line for ${memo}`);
    return found.id;
  });
}

async function linesOf(entryId: string): Promise<{ code: string; debit: number; credit: number }[]> {
  const { rows } = await pool.query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, l.base_debit_cents::text AS debit, l.base_credit_cents::text AS credit
       FROM ledger_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.journal_entry_id = $1 ORDER BY a.code`,
    [entryId],
  );
  return rows.map((r) => ({ code: r.code, debit: Number(r.debit), credit: Number(r.credit) }));
}

async function detailsOf(entryId: string) {
  const { rows } = await pool.query<{ tax_code: string; sign: number; net_cents: string; tax_cents: string }>(
    'SELECT tax_code, sign, net_cents::text, tax_cents::text FROM journal_tax_details WHERE journal_entry_id = $1',
    [entryId],
  );
  return rows.map((r) => ({ code: r.tax_code, sign: r.sign, net: Number(r.net_cents), tax: Number(r.tax_cents) }));
}

async function entryOfLine(id: string): Promise<string> {
  const { rows } = await pool.query<{ e: string }>('SELECT matched_journal_entry_id AS e FROM bank_transactions WHERE id = $1', [id]);
  return rows[0]?.e ?? '';
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'a' });
  userB = await createUserWithOrg({ label: 'b' });
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  expect((await agentA.post('/api/v1/settings/region/australia').send(ACTIVATE)).status).toBe(200);
});

afterAll(async () => {
  await closePool();
});

describe('a bank line', () => {
  it('splits GST out of money going out', async () => {
    const [id] = await importLines(agentA, userA.orgId, [['2026-08-03', 'Stationery', -11000]]);
    const res = await agentA
      .post(`/api/v1/bank-transactions/${id ?? ''}/post-journal`)
      .send({ accountId: await accountId(userA.orgId, '6130'), taxCode: 'P_GST' });
    expect(res.status).toBe(200);
    const entry = await entryOfLine(id ?? '');
    expect(await linesOf(entry)).toEqual([
      { code: '1110', debit: 0, credit: 11000 },
      { code: '1180', debit: 1000, credit: 0 },
      { code: '6130', debit: 10000, credit: 0 },
    ]);
    expect(await detailsOf(entry)).toEqual([{ code: 'P_GST', sign: 1, net: 10000, tax: 1000 }]);
  });

  it('splits GST out of money coming in', async () => {
    const [id] = await importLines(agentA, userA.orgId, [['2026-08-03', 'Cash sale', 5500]]);
    await agentA
      .post(`/api/v1/bank-transactions/${id ?? ''}/post-journal`)
      .send({ accountId: await accountId(userA.orgId, '4200'), taxCode: 'S_GST' });
    const entry = await entryOfLine(id ?? '');
    expect(await linesOf(entry)).toEqual([
      { code: '1110', debit: 5500, credit: 0 },
      { code: '2140', debit: 0, credit: 500 },
      { code: '4200', debit: 0, credit: 5000 },
    ]);
  });

  it('signs a supplier refund against the purchase code', async () => {
    const [id] = await importLines(agentA, userA.orgId, [['2026-08-03', 'Refund from supplier', 1100]]);
    await agentA
      .post(`/api/v1/bank-transactions/${id ?? ''}/post-journal`)
      .send({ accountId: await accountId(userA.orgId, '6130'), taxCode: 'P_GST' });
    const entry = await entryOfLine(id ?? '');
    expect(await detailsOf(entry)).toEqual([{ code: 'P_GST', sign: -1, net: 1000, tax: 100 }]);
    expect(await linesOf(entry)).toEqual([
      { code: '1110', debit: 1100, credit: 0 },
      { code: '1180', debit: 0, credit: 100 },
      { code: '6130', debit: 0, credit: 1000 },
    ]);
  });

  it('with no code and no default, posts as before and records nothing', async () => {
    const [id] = await importLines(agentA, userA.orgId, [['2026-08-03', 'Wages', -50000]]);
    await agentA.post(`/api/v1/bank-transactions/${id ?? ''}/post-journal`).send({ accountId: await accountId(userA.orgId, '6100') });
    const entry = await entryOfLine(id ?? '');
    expect(await linesOf(entry)).toHaveLength(2);
    expect(await detailsOf(entry)).toEqual([]);
  });

  it("uses the account's default on its normal side only", async () => {
    const stationery = await accountId(userA.orgId, '6130');
    await agentA.patch(`/api/v1/accounts/${stationery}`).send({ defaultTaxCode: 'P_GST' });
    const [out, back] = await importLines(agentA, userA.orgId, [
      ['2026-08-03', 'Pens', -2200],
      ['2026-08-04', 'Pens refund', 2200],
    ]);
    await agentA.post(`/api/v1/bank-transactions/${out ?? ''}/post-journal`).send({ accountId: stationery });
    await agentA.post(`/api/v1/bank-transactions/${back ?? ''}/post-journal`).send({ accountId: stationery });
    expect(await detailsOf(await entryOfLine(out ?? ''))).toEqual([{ code: 'P_GST', sign: 1, net: 2000, tax: 200 }]);
    expect(await detailsOf(await entryOfLine(back ?? ''))).toEqual([]);
  });

  it('an unmatch reverses the entry and keeps the detail, linked by reverses_entry_id', async () => {
    const [id] = await importLines(agentA, userA.orgId, [['2026-08-03', 'Stationery', -11000]]);
    await agentA
      .post(`/api/v1/bank-transactions/${id ?? ''}/post-journal`)
      .send({ accountId: await accountId(userA.orgId, '6130'), taxCode: 'P_GST' });
    const entry = await entryOfLine(id ?? '');
    expect((await agentA.post(`/api/v1/bank-transactions/${id ?? ''}/unmatch`).send({})).status).toBe(200);
    expect(await detailsOf(entry)).toHaveLength(1);
    const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM journal_entries WHERE reverses_entry_id = $1', [entry]);
    expect(rows[0]?.n).toBe('1');
  });

  it('a bank rule applies its code', async () => {
    const rule = await agentA.post('/api/v1/bank-rules').send({
      name: 'Fuel',
      memoContains: 'FUEL',
      targetAccountId: await accountId(userA.orgId, '6300'),
      taxCode: 'P_GST',
    });
    expect(rule.status).toBe(201);
    expect(rule.body.bankRule.taxCode).toBe('P_GST');
    const [id] = await importLines(agentA, userA.orgId, [['2026-08-03', 'FUEL STOP', -3300]]);
    const entry = await entryOfLine(id ?? '');
    expect(entry).not.toBe('');
    expect(await detailsOf(entry)).toEqual([{ code: 'P_GST', sign: 1, net: 3000, tax: 300 }]);
  });

  it('refuses a rule with an unknown code', async () => {
    const res = await agentA.post('/api/v1/bank-rules').send({
      name: 'Bad',
      memoContains: 'X',
      targetAccountId: await accountId(userA.orgId, '6300'),
      taxCode: 'NOPE',
    });
    expect(res.status).toBe(422);
  });
});

describe('a manual journal', () => {
  async function post(lines: Record<string, unknown>[]) {
    return agentA.post('/api/v1/manual-journals').send({ entryDate: '2026-08-10', narration: 'Accrual', action: 'post', lines });
  }

  it('splits a coded line and balances', async () => {
    const res = await post([
      { accountId: await accountId(userA.orgId, '6200'), debitCents: 22000, taxCode: 'P_GST' },
      { accountId: await accountId(userA.orgId, '2120'), creditCents: 22000 },
    ]);
    expect(res.status).toBe(201);
    const entry = res.body.journal.journalEntryId as string;
    expect(await linesOf(entry)).toEqual([
      { code: '1180', debit: 2000, credit: 0 },
      { code: '2120', debit: 0, credit: 22000 },
      { code: '6200', debit: 20000, credit: 0 },
    ]);
    expect(await detailsOf(entry)).toEqual([{ code: 'P_GST', sign: 1, net: 20000, tax: 2000 }]);
    expect(res.body.journal.lines[0].taxCode).toBe('P_GST');
  });

  it('ignores an account default, since most manual journals are adjustments', async () => {
    const fees = await accountId(userA.orgId, '6200');
    await agentA.patch(`/api/v1/accounts/${fees}`).send({ defaultTaxCode: 'P_GST' });
    const res = await post([
      { accountId: fees, debitCents: 22000 },
      { accountId: await accountId(userA.orgId, '2120'), creditCents: 22000 },
    ]);
    const entry = res.body.journal.journalEntryId as string;
    expect(await detailsOf(entry)).toEqual([]);
    expect(await linesOf(entry)).toHaveLength(2);
  });

  it('records a void through reverses_entry_id, leaving the detail', async () => {
    const res = await post([
      { accountId: await accountId(userA.orgId, '6200'), debitCents: 22000, taxCode: 'P_GST' },
      { accountId: await accountId(userA.orgId, '2120'), creditCents: 22000 },
    ]);
    const id = res.body.journal.id as string;
    const entry = res.body.journal.journalEntryId as string;
    expect((await agentA.post(`/api/v1/manual-journals/${id}/void`).send({})).status).toBe(200);
    expect(await detailsOf(entry)).toHaveLength(1);
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM journal_entries WHERE reverses_entry_id = $1', [entry]);
    const reversal = await linesOf(rows[0]?.id ?? '');
    expect(reversal.find((l) => l.code === '1180')).toEqual({ code: '1180', debit: 0, credit: 2000 });
  });
});

describe('a generic organization', () => {
  it('refuses GST codes on every path', async () => {
    const [id] = await importLines(agentB, userB.orgId, [['2026-08-03', 'Stationery', -11000]]);
    const account = await accountId(userB.orgId, '6130');
    const line = await agentB.post(`/api/v1/bank-transactions/${id ?? ''}/post-journal`).send({ accountId: account, taxCode: 'P_GST' });
    expect(line.status).toBe(422);
    const rule = await agentB.post('/api/v1/bank-rules').send({ name: 'x', memoContains: 'x', targetAccountId: account, taxCode: 'P_GST' });
    expect(rule.status).toBe(422);
    const journal = await agentB.post('/api/v1/manual-journals').send({
      entryDate: '2026-08-10',
      narration: 'x',
      action: 'post',
      lines: [
        { accountId: account, debitCents: 100, taxCode: 'P_GST' },
        { accountId: await accountId(userB.orgId, '2120'), creditCents: 100 },
      ],
    });
    expect(journal.status).toBe(422);
  });

  it('posts a bank line exactly as before', async () => {
    const [id] = await importLines(agentB, userB.orgId, [['2026-08-03', 'Stationery', -11000]]);
    const res = await agentB.post(`/api/v1/bank-transactions/${id ?? ''}/post-journal`).send({ accountId: await accountId(userB.orgId, '6130') });
    expect(res.status).toBe(200);
    const entry = await entryOfLine(id ?? '');
    expect(await linesOf(entry)).toHaveLength(2);
    expect(await detailsOf(entry)).toEqual([]);
  });
});

describe('across tenants', () => {
  it("cannot post, reverse or code another organization's bank line", async () => {
    await agentB.post('/api/v1/settings/region/australia').send(ACTIVATE);
    const [id] = await importLines(agentA, userA.orgId, [['2026-08-03', 'Stationery', -11000]]);
    const res = await agentB
      .post(`/api/v1/bank-transactions/${id ?? ''}/post-journal`)
      .send({ accountId: await accountId(userB.orgId, '6130'), taxCode: 'P_GST' });
    expect(res.status).toBe(404);
    const { rows } = await pool.query('SELECT 1 FROM journal_tax_details');
    expect(rows).toHaveLength(0);
  });

  it("refuses another organization's account on a coded line, recording nothing", async () => {
    await agentB.post('/api/v1/settings/region/australia').send(ACTIVATE);
    const res = await agentB.post('/api/v1/manual-journals').send({
      entryDate: '2026-08-10',
      narration: 'x',
      action: 'post',
      lines: [
        { accountId: await accountId(userA.orgId, '6200'), debitCents: 1100, taxCode: 'P_GST' },
        { accountId: await accountId(userB.orgId, '2120'), creditCents: 1100 },
      ],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const { rows } = await pool.query('SELECT 1 FROM journal_tax_details');
    expect(rows).toHaveLength(0);
  });

  it("does not let one organization's journal reach another's BAS", async () => {
    await agentB.post('/api/v1/settings/region/australia').send(ACTIVATE);
    const posted = await agentA.post('/api/v1/manual-journals').send({
      entryDate: '2026-02-10',
      narration: 'x',
      action: 'post',
      lines: [
        { accountId: await accountId(userA.orgId, '6200'), debitCents: 1100, taxCode: 'P_GST' },
        { accountId: await accountId(userA.orgId, '2120'), creditCents: 1100 },
      ],
    });
    expect(posted.status).toBe(201);
    const bas = await agentB.post('/api/v1/bas').send({ periodStart: '2026-01-01' });
    expect(bas.body.bas.labels['1B']).toBe(0);
    expect(bas.body.bas.labels.G11).toBe(0);
  });
});

describe('the database', () => {
  it('scopes tax details to their organization and enforces the catalogue', async () => {
    const [id] = await importLines(agentA, userA.orgId, [['2026-08-03', 'Stationery', -11000]]);
    await agentA
      .post(`/api/v1/bank-transactions/${id ?? ''}/post-journal`)
      .send({ accountId: await accountId(userA.orgId, '6130'), taxCode: 'P_GST' });
    const entry = await entryOfLine(id ?? '');
    const { rows } = await pool.query('SELECT 1 FROM journal_tax_details WHERE org_id = $1 AND journal_entry_id = $2', [userB.orgId, entry]);
    expect(rows).toHaveLength(0);
    await expect(
      pool.query(
        `INSERT INTO journal_tax_details (org_id, journal_entry_id, account_id, tax_code, tax_rate_bp, sign, net_cents, tax_cents)
         SELECT org_id, journal_entry_id, account_id, 'NOPE', 0, 1, 0, 0 FROM journal_tax_details WHERE journal_entry_id = $1`,
        [entry],
      ),
    ).rejects.toThrow(/chk_journal_tax_details_code/);
  });
});
