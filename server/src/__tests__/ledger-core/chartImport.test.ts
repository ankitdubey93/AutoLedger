import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — the staged chart-of-accounts importer (Phase 9b). Integration
 * tier, real PostgreSQL. Includes this module's own cross-tenant isolation
 * case (rule 15).
 *
 * Deliberately the inverse of bankImports.test.ts's fixture: a bad row here
 * must stage alongside the good ones, not abort the file.
 */

const app = createApp();
const IMPORTS = '/api/v1/ledger-core/migration-imports';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let userC: SeededUser;
let orgA: string;
let agentA: Agent;

async function accountByCode(orgId: string, code: string): Promise<{ id: string; name: string; type: string; parent_id: string | null } | undefined> {
  const { rows } = await pool.query<{ id: string; name: string; type: string; parent_id: string | null }>(
    'SELECT id, name, type, parent_id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  return rows[0];
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

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'chart-a', orgName: 'Chart Org A' });
  userC = await createUserWithOrg({ label: 'chart-c', orgName: 'Chart Org C' });
  orgA = userA.orgId;

  agentA = await loginAgent(app, userA);
});

afterAll(closePool);

it('a clean chart CSV stages every row VALID and validates to VALIDATED', async () => {
  const content = ['Code,Name,Type,Parent', '9100,Custom Root,Asset,', '9110,Custom Child,Asset,9100'].join('\n');

  const res = await agentA
    .post(IMPORTS)
    .send({ kind: 'CHART_OF_ACCOUNTS', fileName: 'chart.csv', content });

  expect(res.status).toBe(201);
  expect(res.body.import.status).toBe('VALIDATED');
  expect(res.body.import.errorCount).toBe(0);
});

it('a chart CSV with two deliberately corrupt rows stages the rest as VALID and commits only after both are fixed', async () => {
  const content = [
    'Code,Name,Type,Parent',
    '9200,Custom A,Asset,',
    '9210,,Asset,9200',
    '9220,Custom C,Bogus,9200',
  ].join('\n');

  const created = await agentA
    .post(IMPORTS)
    .send({ kind: 'CHART_OF_ACCOUNTS', fileName: 'chart.csv', content });

  expect(created.status).toBe(201);
  expect(created.body.import.errorCount).toBe(2);
  expect(created.body.import.status).toBe('DRAFT');

  const stagedRows: StagedRow[] = created.body.rows;
  expect(stagedRows.filter((r) => r.status === 'VALID')).toHaveLength(1);

  const importId = created.body.import.id as string;

  const commitBeforeFix = await agentA.post(`${IMPORTS}/${importId}/commit`);
  expect(commitBeforeFix.status).toBe(409);

  const badRow1 = rowByCode(stagedRows, '9210');
  const badRow2 = rowByCode(stagedRows, '9220');

  const fix1 = await agentA
    .patch(`${IMPORTS}/${importId}/rows/${badRow1.id}`)
    .send({ accountName: 'Custom B' });
  expect(fix1.status).toBe(200);
  expect(fix1.body.import.status).toBe('DRAFT');

  const fix2 = await agentA
    .patch(`${IMPORTS}/${importId}/rows/${badRow2.id}`)
    .send({ accountType: 'Asset' });
  expect(fix2.status).toBe(200);
  expect(fix2.body.import.status).toBe('VALIDATED');

  const commit = await agentA.post(`${IMPORTS}/${importId}/commit`);
  expect(commit.status).toBe(200);
  expect(commit.body.import.status).toBe('COMMITTED');
});

it('commit creates unknown codes with parents resolved by parent code', async () => {
  const content = ['Code,Name,Type,Parent', '9300,Root Nine,Asset,', '9310,Child Nine,Asset,9300'].join('\n');

  const created = await agentA
    .post(IMPORTS)
    .send({ kind: 'CHART_OF_ACCOUNTS', fileName: 'chart.csv', content });
  const importId = created.body.import.id as string;

  const commit = await agentA.post(`${IMPORTS}/${importId}/commit`);
  expect(commit.status).toBe(200);
  expect(commit.body.result.createdCount).toBe(2);

  const parent = await accountByCode(orgA, '9300');
  const child = await accountByCode(orgA, '9310');
  expect(parent).toBeDefined();
  expect(child).toBeDefined();
  expect(child?.parent_id).toBe(parent?.id);
});

it('commit merges name and description on a known code and never changes its type', async () => {
  const content = ['Code,Name,Type,Parent', '6100,Payroll Costs,Asset,'].join('\n');

  const created = await agentA
    .post(IMPORTS)
    .send({ kind: 'CHART_OF_ACCOUNTS', fileName: 'chart.csv', content });
  const importId = created.body.import.id as string;
  const row = rowByCode(created.body.rows as StagedRow[], '6100');

  expect(row.errors.some((e) => e.includes('already exists as Expense, not Asset'))).toBe(true);

  const fix = await agentA
    .patch(`${IMPORTS}/${importId}/rows/${row.id}`)
    .send({ accountType: 'Expense' });
  expect(fix.body.import.status).toBe('VALIDATED');

  const commit = await agentA.post(`${IMPORTS}/${importId}/commit`);
  expect(commit.status).toBe(200);
  expect(commit.body.result.mergedCount).toBe(1);
  expect(commit.body.result.createdCount).toBe(0);

  const account = await accountByCode(orgA, '6100');
  expect(account?.name).toBe('Payroll Costs');
  expect(account?.type).toBe('Expense');
});

it('a parent cycle inside the file is a row error, not a hang', async () => {
  const content = [
    'Code,Name,Type,Parent',
    '9400,Cycle A,Asset,9410',
    '9410,Cycle B,Asset,9400',
  ].join('\n');

  const started = Date.now();
  const created = await agentA
    .post(IMPORTS)
    .send({ kind: 'CHART_OF_ACCOUNTS', fileName: 'chart.csv', content });
  expect(Date.now() - started).toBeLessThan(1000);

  expect(created.status).toBe(201);
  const rowA = rowByCode(created.body.rows as StagedRow[], '9400');
  const rowB = rowByCode(created.body.rows as StagedRow[], '9410');
  expect(rowA.errors.some((e) => e.includes('forms a cycle'))).toBe(true);
  expect(rowB.errors.some((e) => e.includes('forms a cycle'))).toBe(true);
});

it('a missing code column fails the whole file with 422', async () => {
  const content = ['Name,Type', 'Foo,Asset'].join('\n');

  const res = await agentA
    .post(IMPORTS)
    .send({ kind: 'CHART_OF_ACCOUNTS', fileName: 'chart.csv', content });

  expect(res.status).toBe(422);
  expect(res.body.error).toMatch(/Could not find a/);
});

describe('cross-tenant isolation', () => {
  it('org A cannot read, patch, validate, commit or delete org B\'s import', async () => {
    const agentC = await loginAgent(app, userC);
    const content = ['Code,Name,Type,Parent', '9500,B Account,Asset,'].join('\n');
    const created = await agentC
      .post(IMPORTS)
      .send({ kind: 'CHART_OF_ACCOUNTS', fileName: 'chart.csv', content });
    const importId = created.body.import.id as string;
    const rowId = (created.body.rows as StagedRow[])[0]?.id as string;

    expect((await agentA.get(`${IMPORTS}/${importId}`)).status).toBe(404);
    expect((await agentA.get(`${IMPORTS}/${importId}/rows`)).status).toBe(404);
    expect(
      (await agentA.patch(`${IMPORTS}/${importId}/rows/${rowId}`).send({ accountName: 'Hijacked' })).status,
    ).toBe(404);
    expect((await agentA.post(`${IMPORTS}/${importId}/validate`)).status).toBe(404);
    expect((await agentA.post(`${IMPORTS}/${importId}/commit`)).status).toBe(404);
    expect((await agentA.delete(`${IMPORTS}/${importId}`)).status).toBe(404);
  });
});
