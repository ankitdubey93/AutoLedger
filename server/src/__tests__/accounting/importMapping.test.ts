import request from 'supertest';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Accounting — the staged importer's registry, column mapping, inspect
 * endpoint and hardened commit (Phase 36a). Integration tier, real
 * PostgreSQL. Includes this slice's cross-tenant isolation case (rule 15).
 */

const app = createApp();
const IMPORTS = '/api/v1/migration-imports';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let userC: SeededUser;
let orgA: string;
let agentA: Agent;
let agentC: Agent;

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'map-a', orgName: 'Mapping Org A' });
  userC = await createUserWithOrg({ label: 'map-c', orgName: 'Mapping Org C' });
  orgA = userA.orgId;

  agentA = await loginAgent(app, userA);
  agentC = await loginAgent(app, userC);
});

afterAll(closePool);

async function stage(content: string, kind = 'CUSTOMERS', columnMap?: Record<string, string | null>) {
  return agentA.post(IMPORTS).send({ kind, fileName: 'f.csv', content, ...(columnMap ? { columnMap } : {}) });
}

it('GET /kinds lists the four kinds with template metadata', async () => {
  const res = await agentA.get(`${IMPORTS}/kinds`);

  expect(res.status).toBe(200);
  const kinds = res.body.kinds as {
    kind: string;
    columns: { header: string; required: boolean }[];
    requiredOneOf: string[][];
  }[];
  expect(kinds.map((k) => k.kind)).toEqual(['CHART_OF_ACCOUNTS', 'OPENING_BALANCES', 'CUSTOMERS', 'VENDORS']);
  const customers = kinds.find((k) => k.kind === 'CUSTOMERS');
  expect(customers?.columns[0]?.header).toBe('*ContactName');
  expect(customers?.columns[0]?.required).toBe(true);
  const opening = kinds.find((k) => k.kind === 'OPENING_BALANCES');
  expect(opening?.requiredOneOf).toEqual([['debit', 'credit'], ['amount']]);
});

it('GET /kinds requires authentication', async () => {
  const res = await request(app).get(`${IMPORTS}/kinds`);
  expect(res.status).toBe(401);
});

it('inspect: our own template is an exact match', async () => {
  const res = await agentA
    .post(`${IMPORTS}/inspect`)
    .send({ kind: 'CUSTOMERS', content: '*ContactName,EmailAddress\nAcme,a@x.test' });

  expect(res.status).toBe(200);
  const i = res.body.inspection;
  expect(i.exactMatch).toBe(true);
  expect(i.missingRequired).toEqual([]);
  expect(i.rowCount).toBe(1);
  expect(i.suggestedMap.partyName).toBe('*ContactName');
  expect(i.suggestedMap.partyEmail).toBe('EmailAddress');
  expect(i.sampleRows).toEqual([['Acme', 'a@x.test']]);
});

it('inspect: foreign headers resolve by synonym but are not an exact match', async () => {
  const res = await agentA
    .post(`${IMPORTS}/inspect`)
    .send({ kind: 'CUSTOMERS', content: 'Contact Name,Email Address,Mobile\nAcme,a@x.test,555' });

  expect(res.status).toBe(200);
  const i = res.body.inspection;
  expect(i.exactMatch).toBe(false);
  expect(i.suggestedMap.partyName).toBe('Contact Name');
  expect(i.suggestedMap.partyEmail).toBe('Email Address');
  expect(i.suggestedMap.partyPhone).toBe('Mobile');
});

it('inspect: a missing required column is reported, not rejected', async () => {
  const res = await agentA.post(`${IMPORTS}/inspect`).send({ kind: 'CUSTOMERS', content: 'Foo,Bar\n1,2' });

  expect(res.status).toBe(200);
  expect(res.body.inspection.missingRequired).toEqual(['partyName']);
  expect(res.body.inspection.suggestedMap.partyName).toBeNull();
});

it('inspect: more than 5000 rows is 422', async () => {
  const lines = ['Name'];
  for (let i = 0; i < 5001; i += 1) lines.push(`P${String(i)}`);

  const res = await agentA.post(`${IMPORTS}/inspect`).send({ kind: 'CUSTOMERS', content: lines.join('\n') });

  expect(res.status).toBe(422);
  expect(res.body.error).toContain('at most 5000');
});

it('inspect is refused to a VIEWER', async () => {
  const viewer = await createUserWithOrg({ label: 'map-viewer' });
  await addMember(orgA, viewer.id, 'VIEWER');
  const agent = await loginAgent(app, viewer);
  const switched = await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });
  expect(switched.status).toBe(200);

  const res = await agent.post(`${IMPORTS}/inspect`).send({ kind: 'CUSTOMERS', content: 'Name\nAcme' });

  expect(res.status).toBe(403);
});

it('stage with a column map', async () => {
  const map = { partyName: 'Customer Title', partyEmail: 'Mail' };
  const res = await stage('Customer Title,Mail\nAcme,a@x.test', 'CUSTOMERS', map);

  expect(res.status).toBe(201);
  expect(res.body.import.columnMap).toEqual(map);

  const rows = await agentA.get(`${IMPORTS}/${res.body.import.id as string}/rows`);
  expect(rows.body.rows[0].partyName).toBe('Acme');
  expect(rows.body.rows[0].partyEmail).toBe('a@x.test');
});

it('column map: unknown key is 400', async () => {
  const res = await stage('Name\nAcme', 'CUSTOMERS', { bogus: 'Name' });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('Unknown column "bogus" for a Customers import');
});

it('column map: a header not in the file is 400', async () => {
  const res = await stage('Name\nAcme', 'CUSTOMERS', { partyName: 'Nope' });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('The file has no column named "Nope"');
});

it('column map: one header mapped twice is 400', async () => {
  const res = await stage('Name\nAcme', 'CUSTOMERS', { partyName: 'Name', partyEmail: 'Name' });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('Column "Name" is mapped to more than one field');
});

it('column map: explicit null wins over automatic', async () => {
  const res = await stage('Name\nAcme', 'CUSTOMERS', { partyName: null });
  expect(res.status).toBe(422);
  expect(res.body.error).toBe('Could not find a name column in the file');
});

it('compact matching accepts starred template headers', async () => {
  const res = await stage('*Code,*Name,*Type\n9100,Custom Root,Asset', 'CHART_OF_ACCOUNTS');
  expect(res.status).toBe(201);
  expect(res.body.import.errorCount).toBe(0);
});

it('Xero account types are converted', async () => {
  const res = await stage('Code,Name,Type\n9100,Bank X,Bank\n9200,Overheads X,Overhead', 'CHART_OF_ACCOUNTS');
  expect(res.status).toBe(201);
  expect(res.body.import.errorCount).toBe(0);
  const types = (res.body.rows as { accountType: string }[]).map((r) => r.accountType);
  expect(types).toEqual(['Asset', 'Expense']);
});

it('a chart file with no name column is 422', async () => {
  const res = await stage('Code,Type\n9100,Asset', 'CHART_OF_ACCOUNTS');
  expect(res.status).toBe(422);
  expect(res.body.error).toBe('Could not find an account name column in the file');
});

async function stageAndCommit(): Promise<{ id: string; commit: request.Response }> {
  const staged = await stage('Name\nAcme');
  const id = staged.body.import.id as string;
  const commit = await agentA.post(`${IMPORTS}/${id}/commit`);
  return { id, commit };
}

it('commit persists its result', async () => {
  const { id, commit } = await stageAndCommit();
  expect(commit.status).toBe(200);

  const res = await agentA.get(`${IMPORTS}/${id}`);
  expect(res.body.import.result).toEqual({ kind: 'CUSTOMERS', createdCount: 1, mergedCount: 0 });
});

it('a second commit is 409', async () => {
  const { id } = await stageAndCommit();
  const again = await agentA.post(`${IMPORTS}/${id}/commit`);
  expect(again.status).toBe(409);
  expect(again.body.error).toBe('This import has already been committed');
});

it('two concurrent commits: exactly one succeeds', async () => {
  const staged = await stage('Name\nAcme');
  expect(staged.body.import.status).toBe('VALIDATED');
  const id = staged.body.import.id as string;

  const [r1, r2] = await Promise.all([
    agentA.post(`${IMPORTS}/${id}/commit`),
    agentA.post(`${IMPORTS}/${id}/commit`),
  ]);

  expect([r1.status, r2.status].sort()).toEqual([200, 409]);
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM customers WHERE org_id = $1 AND name = 'Acme'`,
    [orgA],
  );
  expect(rows[0]?.count).toBe('1');
});

it('list filters by status', async () => {
  await stageAndCommit();

  const res = await agentA.get(`${IMPORTS}?status=COMMITTED`);
  expect(res.status).toBe(200);
  expect(res.body.totalCount).toBe(1);

  const bad = await agentA.get(`${IMPORTS}?status=BOGUS`);
  expect(bad.status).toBe(400);
});

it("cross-tenant: org B cannot read, fix or commit org A's import", async () => {
  const staged = await stage('Name\nAcme');
  const id = staged.body.import.id as string;
  const rowId = staged.body.rows[0].id as string;

  const read = await agentC.get(`${IMPORTS}/${id}`);
  expect(read.status).toBe(404);

  const patch = await agentC.patch(`${IMPORTS}/${id}/rows/${rowId}`).send({ partyName: 'X' });
  expect(patch.status).toBe(404);

  const commit = await agentC.post(`${IMPORTS}/${id}/commit`);
  expect(commit.status).toBe(404);
});

it('a customer payment-terms column is kept in notes', async () => {
  const staged = await stage('Name,Payment Terms,Notes\nAcme,Net 30,Key account');
  expect(staged.status).toBe(201);
  const id = (staged.body.import ?? staged.body).id as string;

  const commit = await agentA.post(`${IMPORTS}/${id}/commit`).send({});
  expect(commit.status).toBe(200);

  const { rows } = await pool.query<{ notes: string }>(
    `SELECT notes FROM customers WHERE org_id = $1 AND name = 'Acme'`,
    [orgA],
  );
  expect(rows[0]?.notes).toContain('Key account');
  expect(rows[0]?.notes).toContain('Payment terms: Net 30');
});
