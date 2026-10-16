import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Accounting — the grouped `JOURNALS` import kind (Phase 36c): many CSV rows are
 * one journal entry, validated as a whole and posted in one transaction with
 * `source_type 'migration_import'`; plus the bulk include/exclude endpoint.
 * Integration tier, real PostgreSQL. Includes this slice's cross-tenant
 * isolation case (rule 15).
 */

const app = createApp();
const IMPORTS = '/api/v1/migration-imports';
const PERIODS = '/api/v1/fiscal-periods';
const ONBOARDING = '/api/v1/settings/onboarding';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

interface Row {
  id: string;
  rowNumber: number;
  status: string;
  errors: string[];
  groupKey: string | null;
}

let userA: SeededUser;
let userB: SeededUser;
let agentA: Agent;
let agentB: Agent;

async function onboard(agent: Agent): Promise<void> {
  const res = await agent.post(ONBOARDING).send({
    organizationName: 'Journal Import Books',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    booksStartDate: '2026-01-01',
  });
  if (res.status !== 200) throw new Error(`fixture: onboarding failed ${res.status} ${res.text}`);
}

let periods: { id: string; startsOn: string }[] = [];

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'jrn-a', orgName: 'Journal Import Org A' });
  userB = await createUserWithOrg({ label: 'jrn-b', orgName: 'Journal Import Org B' });
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  await onboard(agentA);
  await onboard(agentB);
  const gen = await agentA.post(`${PERIODS}/generate`).send({ containingDate: '2026-06-15' });
  if (gen.status !== 201) throw new Error(`fixture: generate periods failed ${gen.status}`);
  periods = gen.body.periods as { id: string; startsOn: string }[];
});

afterAll(closePool);

const HEADER = 'JournalNumber,*Date,*Narration,*AccountCode,Debit,Credit';
const XERO_HEADER = '*Date,*Narration,*AccountCode,Debit,Credit';

async function stage(agent: Agent, content: string, kind = 'JOURNALS') {
  return agent.post(IMPORTS).send({ kind, fileName: 'journals.csv', content });
}

async function stageOk(content: string, agent: Agent = agentA): Promise<string> {
  const res = await stage(agent, content);
  expect(res.status).toBe(201);
  return res.body.import.id as string;
}

async function getRows(id: string, agent: Agent = agentA): Promise<Row[]> {
  const res = await agent.get(`${IMPORTS}/${id}/rows`);
  expect(res.status).toBe(200);
  return res.body.rows as Row[];
}

async function validate(id: string, agent: Agent = agentA) {
  const res = await agent.post(`${IMPORTS}/${id}/validate`);
  expect(res.status).toBe(200);
  return res;
}

async function periodIdFor(startsOn: string): Promise<string> {
  const p = periods.find((x) => x.startsOn === startsOn);
  if (p === undefined) throw new Error(`fixture: no period ${startsOn}`);
  return p.id;
}

describe('staging and validation', () => {
  it('rows sharing a JournalNumber stage as one balanced entry', async () => {
    const res = await stage(
      agentA,
      [
        HEADER,
        'J-1,2026-03-31,June accruals,6100,1000.00,',
        'J-1,2026-03-31,June accruals,1130,,600.00',
        'J-1,2026-03-31,June accruals,1130,,400.00',
      ].join('\n'),
    );
    expect(res.status).toBe(201);
    expect(res.body.import.errorCount).toBe(0);
    const id = res.body.import.id as string;

    const rows = await getRows(id);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.groupKey).not.toBeNull();
    expect(new Set(rows.map((r) => r.groupKey)).size).toBe(1);

    await validate(id);
    const preview = await agentA.get(`${IMPORTS}/${id}/preview`);
    expect(preview.status).toBe(200);
    const summary = preview.body.preview.summary as { label: string; value: number }[];
    expect(summary.find((s) => s.label === 'Journal entries to post')?.value).toBe(1);
    expect(summary.find((s) => s.label === 'Lines')?.value).toBe(3);
    expect(summary.find((s) => s.label === 'Total debits')?.value).toBe(100000);
  });

  it('without a JournalNumber, Date + Narration group rows (Xero-style)', async () => {
    const id = await stageOk(
      [
        XERO_HEADER,
        '2026-03-31,Accrue rent,6100,500.00,',
        '2026-03-31,Accrue rent,1130,,500.00',
        '2026-03-31,Accrue power,6100,80.00,',
        '2026-03-31,Accrue power,1130,,80.00',
      ].join('\n'),
    );
    await validate(id);

    const rows = await getRows(id);
    expect(rows.every((r) => r.errors.length === 0)).toBe(true);
    const preview = await agentA.get(`${IMPORTS}/${id}/preview`);
    const summary = preview.body.preview.summary as { label: string; value: number }[];
    expect(summary.find((s) => s.label === 'Journal entries to post')?.value).toBe(2);
    expect(summary.find((s) => s.label === 'Lines')?.value).toBe(4);
  });

  it('a signed Amount column works instead of Debit/Credit', async () => {
    const id = await stageOk(
      ['JournalNumber,*Date,*Narration,*AccountCode,Amount', 'J-1,2026-03-31,Signed,6100,250', 'J-1,2026-03-31,Signed,1130,-250'].join('\n'),
    );
    await validate(id);

    const rows = await getRows(id);
    expect(rows.map((r) => r.status)).toEqual(['VALID', 'VALID']);
  });

  it('an unbalanced journal flags every row in it', async () => {
    const id = await stageOk(
      [HEADER, 'J-2,2026-03-31,Off by ten,6100,100.00,', 'J-2,2026-03-31,Off by ten,1130,,90.00'].join('\n'),
    );
    await validate(id);

    const rows = await getRows(id);
    const expected = 'The journal J-2 does not balance: debits 100.00, credits 90.00';
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.status).toBe('INVALID');
      expect(r.errors).toContain(expected);
    }
  });

  it('a single-line journal is refused', async () => {
    const id = await stageOk([HEADER, 'J-3,2026-03-31,Lonely,6100,100.00,'].join('\n'));
    await validate(id);

    const rows = await getRows(id);
    expect(rows[0]?.status).toBe('INVALID');
    expect(rows[0]?.errors).toContain('The journal J-3 has only one line — an entry needs at least two');
  });

  it('mismatched dates within a numbered journal flag the differing row only', async () => {
    const id = await stageOk(
      [HEADER, 'J-4,2026-03-31,Split dates,6100,100.00,', 'J-4,2026-04-01,Split dates,1130,,100.00'].join('\n'),
    );
    await validate(id);

    const [first, second] = await getRows(id);
    const expected = 'Date differs from row 2 (2026-03-31) — every line of journal J-4 must match';
    expect(second?.errors).toContain(expected);
    expect(first?.errors.some((e) => e.startsWith('Date differs'))).toBe(false);
    expect(first?.errors.some((e) => e.startsWith('Narration differs'))).toBe(false);
  });

  it('control accounts are refused at validation with the manual-journal message', async () => {
    const id = await stageOk(
      [HEADER, 'J-5,2026-03-31,To AR,1120,100.00,', 'J-5,2026-03-31,To AR,4100,,100.00'].join('\n'),
    );
    await validate(id);

    // The message the manual-journal path throws, straight from the shared map.
    const { listControlAccountsOnClient } = await import('../../services/accounting/journalService.js');
    const client = await pool.connect();
    let message: string | undefined;
    try {
      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
        [userA.orgId, '1120'],
      );
      message = (await listControlAccountsOnClient(client, userA.orgId)).get(rows[0]?.id ?? '');
    } finally {
      client.release();
    }
    expect(message).toBeDefined();

    const rows = await getRows(id);
    expect(rows[0]?.status).toBe('INVALID');
    expect(rows[0]?.errors).toContain(message);
    expect(rows[1]?.errors).not.toContain(message);

    // And the manual path really throws that same text.
    const manual = await agentA.post('/api/v1/journals').send({
      entryDate: '2026-03-31',
      description: 'manual to AR',
      lines: [
        { accountId: (await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id=$1 AND code=$2', [userA.orgId, '1120'])).rows[0]?.id, debitCents: 100, creditCents: 0 },
        { accountId: (await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id=$1 AND code=$2', [userA.orgId, '4100'])).rows[0]?.id, debitCents: 0, creditCents: 100 },
      ],
    });
    expect(manual.status).toBe(422);
    expect(manual.body.error).toBe(message);
  });

  it('a closed period is a row error', async () => {
    const close = await agentA.post(`${PERIODS}/${await periodIdFor('2026-03-01')}/close`);
    expect(close.status).toBe(200);

    const id = await stageOk(
      [HEADER, 'J-6,2026-03-31,Too late,6100,100.00,', 'J-6,2026-03-31,Too late,1130,,100.00'].join('\n'),
    );
    await validate(id);

    const rows = await getRows(id);
    for (const r of rows) {
      expect(r.status).toBe('INVALID');
      expect(r.errors.some((e) => e.includes('is closed; reopen it or change the date'))).toBe(true);
    }
  });
});

describe('commit', () => {
  it('commit posts one entry per group with source migration_import', async () => {
    const id = await stageOk(
      [
        HEADER,
        'J-1,2026-03-31,March rent accrual,6100,500.00,',
        'J-1,2026-03-31,March rent accrual,1130,,500.00',
        'J-2,2026-04-15,April power accrual,6100,80.00,',
        'J-2,2026-04-15,April power accrual,1130,,80.00',
      ].join('\n'),
    );
    await validate(id);

    const commit = await agentA.post(`${IMPORTS}/${id}/commit`);

    expect(commit.status).toBe(200);
    expect(commit.body.result).toEqual({ kind: 'JOURNALS', entryCount: 2, lineCount: 4 });

    const list = await agentA.get('/api/v1/journals');
    const entries = list.body.entries as { id: string; description: string }[];
    expect(entries.map((e) => e.description).sort()).toEqual(['April power accrual', 'March rent accrual']);

    const first = entries[0];
    if (first === undefined) throw new Error('no entry');
    const detail = await agentA.get(`/api/v1/journals/${first.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.entry.sourceType).toBe('migration_import');
    expect(detail.body.entry.sourceId).toBe(id);

    const tb = await agentA.get('/api/v1/reports/trial-balance');
    expect(tb.status).toBe(200);
    expect(tb.body.isBalanced).toBe(true);
    expect(tb.body.totalDebitCents).toBe(58000);
    expect(tb.body.totalCreditCents).toBe(58000);
  });

  it('revalidate at commit: a period closed after validation blocks commit', async () => {
    const id = await stageOk(
      [HEADER, 'J-1,2026-03-31,Will be blocked,6100,100.00,', 'J-1,2026-03-31,Will be blocked,1130,,100.00'].join('\n'),
    );
    await validate(id);
    const close = await agentA.post(`${PERIODS}/${await periodIdFor('2026-03-01')}/close`);
    expect(close.status).toBe(200);

    const commit = await agentA.post(`${IMPORTS}/${id}/commit`);

    expect(commit.status).toBe(409);
    expect(commit.body.error).toContain('became invalid since validation');
    const { rows } = await pool.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM journal_entries WHERE org_id = $1 AND source_type = 'migration_import'",
      [userA.orgId],
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('a larger import commits in one transaction (timing)', async () => {
    const lines = [HEADER];
    for (let i = 1; i <= 200; i += 1) {
      const n = `J-${String(i)}`;
      lines.push(`${n},2026-03-31,Bulk ${String(i)},6100,10.00,`, `${n},2026-03-31,Bulk ${String(i)},1130,,10.00`);
    }
    const id = await stageOk(lines.join('\n'));
    await validate(id);

    const started = Date.now();
    const commit = await agentA.post(`${IMPORTS}/${id}/commit`);
    const ms = Date.now() - started;
    // eslint-disable-next-line no-console
    console.log(`TIMING: committed 200 two-line journals in ${String(ms)} ms`);

    expect(commit.status).toBe(200);
    expect(commit.body.result).toEqual({ kind: 'JOURNALS', entryCount: 200, lineCount: 400 });
  }, 60_000);
});

describe('grouped-kind machinery', () => {
  it('editing a JournalNumber regroups the row', async () => {
    const id = await stageOk(
      [
        HEADER,
        'J-1,2026-03-31,First,6100,100.00,',
        'J-1,2026-03-31,First,1130,,100.00',
        'J-9,2026-03-31,First,1130,,0.01',
      ].join('\n'),
    );
    const before = await getRows(id);
    const third = before[2];
    const first = before[0];
    if (third === undefined || first === undefined) throw new Error('rows missing');
    expect(third.groupKey).not.toBe(first.groupKey);

    const patch = await agentA.patch(`${IMPORTS}/${id}/rows/${third.id}`).send({ values: { journalNumber: 'J-1' } });
    expect(patch.status).toBe(200);

    const after = await getRows(id);
    const moved = after.find((r) => r.id === third.id);
    expect(moved?.groupKey).toBe(first.groupKey);
    expect(after.map((r) => r.rowNumber)).toEqual([2, 3, 4]);
    const keys = after.map((r) => r.groupKey);
    expect(new Set(keys).size).toBe(1);
  });

  it('bulk exclude drops a whole journal and revalidates', async () => {
    const id = await stageOk(
      [
        HEADER,
        'J-1,2026-03-31,Good,6100,100.00,',
        'J-1,2026-03-31,Good,1130,,100.00',
        'J-2,2026-03-31,Bad,6100,100.00,',
        'J-2,2026-03-31,Bad,1130,,90.00',
      ].join('\n'),
    );
    await validate(id);
    const rows = await getRows(id);
    const bad = rows.filter((r) => r.status === 'INVALID');
    expect(bad).toHaveLength(2);

    const res = await agentA.post(`${IMPORTS}/${id}/rows/status`).send({ rowIds: bad.map((r) => r.id), status: 'EXCLUDED' });

    expect(res.status).toBe(200);
    expect(res.body.import.status).toBe('VALIDATED');
    const commit = await agentA.post(`${IMPORTS}/${id}/commit`);
    expect(commit.status).toBe(200);
    expect(commit.body.result).toEqual({ kind: 'JOURNALS', entryCount: 1, lineCount: 2 });
  });

  it('bulk status: unknown row ids are 404, committed import is 409', async () => {
    const id = await stageOk([HEADER, 'J-1,2026-03-31,Ok,6100,100.00,', 'J-1,2026-03-31,Ok,1130,,100.00'].join('\n'));
    await validate(id);
    const rows = await getRows(id);

    const unknown = await agentA.post(`${IMPORTS}/${id}/rows/status`).send({ rowIds: [randomUUID()], status: 'EXCLUDED' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('Some rows were not found in this import');

    const commit = await agentA.post(`${IMPORTS}/${id}/commit`);
    expect(commit.status).toBe(200);

    const late = await agentA.post(`${IMPORTS}/${id}/rows/status`).send({ rowIds: rows.map((r) => r.id), status: 'EXCLUDED' });
    expect(late.status).toBe(409);
    expect(late.body.error).toBe('This import has already been committed');
  });

  it('more than 1000 journals is 422', async () => {
    const lines = [HEADER];
    for (let i = 1; i <= 1001; i += 1) lines.push(`J-${String(i)},2026-03-31,Single,6100,1.00,`);

    const res = await stage(agentA, lines.join('\n'));

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('1001 journals; one import takes at most 1000');
  }, 60_000);
});

describe('tenant isolation', () => {
  it("cross-tenant: org B's accounts don't resolve; org B cannot read, bulk-exclude or commit org A's import", async () => {
    // A code that exists only in org A.
    const created = await agentA.post('/api/v1/accounts').send({ code: '6999', name: 'Org A only', type: 'Expense' });
    expect(created.status).toBe(201);

    const content = [HEADER, 'J-1,2026-03-31,Mine,6999,100.00,', 'J-1,2026-03-31,Mine,1130,,100.00'].join('\n');

    const idA = await stageOk(content, agentA);
    await validate(idA);
    const rowsA = await getRows(idA);
    expect(rowsA.every((r) => r.status === 'VALID')).toBe(true);

    const idB = await stageOk(content, agentB);
    await validate(idB, agentB);
    const rowsB = await getRows(idB, agentB);
    expect(rowsB[0]?.errors.some((e) => e.includes('6999'))).toBe(true);
    expect(rowsB[0]?.status).toBe('INVALID');

    expect((await agentB.get(`${IMPORTS}/${idA}/rows`)).status).toBe(404);
    const bulk = await agentB.post(`${IMPORTS}/${idA}/rows/status`).send({ rowIds: rowsA.map((r) => r.id), status: 'EXCLUDED' });
    expect(bulk.status).toBe(404);
    expect((await agentB.post(`${IMPORTS}/${idA}/commit`)).status).toBe(404);

    // Org A's rows were untouched by B's attempts.
    expect((await getRows(idA)).every((r) => r.status === 'VALID')).toBe(true);
  });
});
