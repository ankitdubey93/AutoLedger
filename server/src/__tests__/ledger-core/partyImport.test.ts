import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — the staged customer/vendor importer (Phase 24). Integration
 * tier, real PostgreSQL. Extends the Phase 9 staged importer (chartImport,
 * openingBalanceImport) with two new kinds. Includes this module's own
 * cross-tenant isolation case (rule 15).
 */

const app = createApp();
const IMPORTS = '/api/v1/ledger-core/migration-imports';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let userC: SeededUser;
let orgA: string;
let orgB: string;
let agentA: Agent;
let agentC: Agent;

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'party-a', orgName: 'Party Org A' });
  userC = await createUserWithOrg({ label: 'party-c', orgName: 'Party Org C' });
  orgA = userA.orgId;
  orgB = userC.orgId;

  agentA = await loginAgent(app, userA);
  agentC = await loginAgent(app, userC);
});

afterAll(closePool);

it('a customer CSV stages every row as VALID', async () => {
  const content = [
    'Name,Email,Phone,Billing Address,Tax Number,Notes',
    'Northwind Traders,ap@northwind.test,555-0100,1 Main St,TAX-1,First customer',
    'Contoso Ltd,ap@contoso.test,555-0200,2 Elm St,TAX-2,Second customer',
    'Fabrikam Inc,ap@fabrikam.test,555-0300,3 Oak St,TAX-3,Third customer',
  ].join('\n');

  const res = await agentA.post(IMPORTS).send({ kind: 'CUSTOMERS', fileName: 'customers.csv', content });

  expect(res.status).toBe(201);
  expect(res.body.import.rowCount).toBe(3);
  expect(res.body.import.errorCount).toBe(0);
  expect(res.body.import.status).toBe('VALIDATED');
});

it('a row with no name is INVALID', async () => {
  const content = ['Name,Email', ',blank@example.test'].join('\n');

  const res = await agentA.post(IMPORTS).send({ kind: 'CUSTOMERS', fileName: 'customers.csv', content });

  expect(res.body.import.status).toBe('DRAFT');
  const row = res.body.rows[0];
  expect(row.status).toBe('INVALID');
  expect(row.errors).toContain('name is required');
});

it('a malformed email is INVALID', async () => {
  const content = ['Name,Email', 'Northwind Traders,not-an-email'].join('\n');

  const res = await agentA.post(IMPORTS).send({ kind: 'CUSTOMERS', fileName: 'customers.csv', content });

  const row = res.body.rows[0];
  expect(row.errors).toContain('"not-an-email" is not a valid email address');
});

it('committing creates the customers', async () => {
  const content = [
    'Name,Email',
    'Northwind Traders,ap@northwind.test',
    'Contoso Ltd,ap@contoso.test',
    'Fabrikam Inc,ap@fabrikam.test',
  ].join('\n');

  const created = await agentA.post(IMPORTS).send({ kind: 'CUSTOMERS', fileName: 'customers.csv', content });
  const importId = created.body.import.id as string;

  const commit = await agentA.post(`${IMPORTS}/${importId}/commit`);
  expect(commit.status).toBe(200);
  expect(commit.body.result.createdCount).toBe(3);

  const list = await agentA.get('/api/v1/ledger-core/customers');
  const names = (list.body.customers as { name: string }[]).map((c) => c.name).sort();
  expect(names).toEqual(['Contoso Ltd', 'Fabrikam Inc', 'Northwind Traders']);
});

it('emails are lowercased on commit', async () => {
  const content = ['Name,Email', 'Northwind Traders,Ada@EXAMPLE.com'].join('\n');
  const created = await agentA.post(IMPORTS).send({ kind: 'CUSTOMERS', fileName: 'customers.csv', content });
  const importId = created.body.import.id as string;

  await agentA.post(`${IMPORTS}/${importId}/commit`);

  const list = await agentA.get('/api/v1/ledger-core/customers');
  expect(list.body.customers[0].email).toBe('ada@example.com');
});

it('a name already in the system merges instead of duplicating', async () => {
  await agentA.post('/api/v1/ledger-core/customers').send({ name: 'Harbor Point' });

  const content = ['Name,Phone', 'Harbor Point,555-9999'].join('\n');
  const created = await agentA.post(IMPORTS).send({ kind: 'CUSTOMERS', fileName: 'customers.csv', content });
  const importId = created.body.import.id as string;

  const commit = await agentA.post(`${IMPORTS}/${importId}/commit`);
  expect(commit.body.result.mergedCount).toBe(1);
  expect(commit.body.result.createdCount).toBe(0);

  const list = await agentA.get('/api/v1/ledger-core/customers');
  const harborPoints = (list.body.customers as { name: string; phone: string | null }[]).filter(
    (c) => c.name === 'Harbor Point',
  );
  expect(harborPoints).toHaveLength(1);
  expect(harborPoints[0]?.phone).toBe('555-9999');
});

it('a merge never overwrites an existing value', async () => {
  await agentA.post('/api/v1/ledger-core/customers').send({ name: 'Harbor Point', email: 'old@example.com' });

  const content = ['Name,Email', 'Harbor Point,new@example.com'].join('\n');
  const created = await agentA.post(IMPORTS).send({ kind: 'CUSTOMERS', fileName: 'customers.csv', content });
  const importId = created.body.import.id as string;

  await agentA.post(`${IMPORTS}/${importId}/commit`);

  const list = await agentA.get('/api/v1/ledger-core/customers');
  expect(list.body.customers[0].email).toBe('old@example.com');
});

it('a vendor CSV maps payment terms onto the vendor', async () => {
  const content = ['Name,Payment Terms', 'Acme Supplies,Net 30'].join('\n');
  const created = await agentA.post(IMPORTS).send({ kind: 'VENDORS', fileName: 'vendors.csv', content });
  const importId = created.body.import.id as string;

  await agentA.post(`${IMPORTS}/${importId}/commit`);

  const list = await agentA.get('/api/v1/ledger-core/vendors');
  expect(list.body.vendors[0].paymentTerms).toBe('Net 30');
});

it('committing twice is refused', async () => {
  const content = ['Name', 'Northwind Traders'].join('\n');
  const created = await agentA.post(IMPORTS).send({ kind: 'CUSTOMERS', fileName: 'customers.csv', content });
  const importId = created.body.import.id as string;

  await agentA.post(`${IMPORTS}/${importId}/commit`);
  const second = await agentA.post(`${IMPORTS}/${importId}/commit`);

  expect(second.status).toBe(409);
});

it('a header row with no recognisable name column is rejected', async () => {
  const content = ['Foo,Bar', '1,2'].join('\n');

  const res = await agentA.post(IMPORTS).send({ kind: 'CUSTOMERS', fileName: 'customers.csv', content });

  expect(res.status).toBe(422);
  expect(res.body.error).toBe('Could not find a name column in the file');
});

describe('cross-tenant isolation on a party import', () => {
  it('org A cannot read, patch or commit an org B party import', async () => {
    const content = ['Name', 'Org B Customer'].join('\n');
    const created = await agentC.post(IMPORTS).send({ kind: 'CUSTOMERS', fileName: 'customers.csv', content });
    const importId = created.body.import.id as string;
    const rowId = created.body.rows[0].id as string;

    expect((await agentA.get(`${IMPORTS}/${importId}`)).status).toBe(404);
    expect(
      (await agentA.patch(`${IMPORTS}/${importId}/rows/${rowId}`).send({ partyName: 'Hijacked' })).status,
    ).toBe(404);
    expect((await agentA.post(`${IMPORTS}/${importId}/commit`)).status).toBe(404);

    const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM customers WHERE org_id = $1', [orgA]);
    expect(Number(rows[0]?.count)).toBe(0);
    expect(orgB).not.toBe(orgA);
  });
});
