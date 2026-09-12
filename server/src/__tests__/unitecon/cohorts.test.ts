import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * unitecon cohorts API (Phase 14). Integration tier, real PostgreSQL.
 * Includes this module's cross-tenant isolation suite (rule 15).
 */

const app = createApp();
const COHORTS = '/api/v1/unitecon/cohorts';
const CUSTOMERS = '/api/v1/ledger-core/customers';
const INVOICES = '/api/v1/ledger-core/invoices';

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;

type Agent = Awaited<ReturnType<typeof loginAgent>>;

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
}

async function createCustomer(agent: Agent, name: string): Promise<string> {
  const res = await agent.post(CUSTOMERS).send({ name });
  return res.body.customer.id as string;
}

async function issueInvoice(
  agent: Agent,
  customerId: string,
  revenueAccountId: string,
  quantityMilli: number,
  unitPriceCents: number,
  issueDate: string,
  dueDate: string,
): Promise<void> {
  const created = await agent.post(INVOICES).send({
    customerId,
    issueDate,
    dueDate,
    notes: null,
    paymentTerms: null,
    lines: [
      {
        description: 'Widgets',
        quantityMilli,
        unitPriceCents,
        revenueAccountId,
        taxRateBp: 0,
      },
    ],
  });
  const invoiceId = created.body.invoice.id as string;
  await agent.post(`${INVOICES}/${invoiceId}/issue`).send({});
}

async function switchTo(agent: Agent, targetOrgId: string) {
  const res = await agent.post('/api/v1/auth/switch-org').send({ orgId: targetOrgId });
  expect(res.status).toBe(200);
  return agent;
}

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userB.orgId;
});

afterAll(closePool);

describe('unitecon cohorts API', () => {
  it('401s with no session', async () => {
    const res = await request(app).get(COHORTS).query({ from: '2026-01-01', to: '2026-03-01' });
    expect(res.status).toBe(401);
  });

  it('400s when from is missing', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(COHORTS).query({ to: '2026-03-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('from and to are required');
  });

  it('400s on a malformed month', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(COHORTS).query({ from: '2026-01-15', to: '2026-03-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('first of a month');
  });

  it('422s when from is after to', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(COHORTS).query({ from: '2026-03-01', to: '2026-01-01' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('from must not be after to');
  });

  it('422s on a window over 60 months', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(COHORTS).query({ from: '2020-01-01', to: '2026-12-01' });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('at most 60 months');
  });

  it('happy path: retention and revenue per cell', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent, 'Acme');
    const revenueAccountId = await accountId(orgA, '4100');

    await issueInvoice(agent, customerId, revenueAccountId, 1000, 100000, '2026-01-05', '2026-01-31');
    await issueInvoice(agent, customerId, revenueAccountId, 1000, 60000, '2026-02-05', '2026-02-28');

    const res = await agent.get(COHORTS).query({ from: '2026-01-01', to: '2026-02-01' });

    expect(res.status).toBe(200);
    const rows = res.body.cohorts.matrix.rows as {
      cohortMonth: string;
      cohortSize: number;
      cells: { netRevenueCents: number; retentionBps: number }[];
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cohortMonth).toBe('2026-01-01');
    expect(rows[0]?.cohortSize).toBe(1);
    expect(rows[0]?.cells[0]?.netRevenueCents).toBe(100000);
    expect(rows[0]?.cells[1]?.netRevenueCents).toBe(60000);
    expect(rows[0]?.cells[1]?.retentionBps).toBe(10000);
  });

  it('shows churn as 0 activity, not a missing row', async () => {
    const agent = await loginAgent(app, userA);
    const customer1 = await createCustomer(agent, 'Acme 1');
    const customer2 = await createCustomer(agent, 'Acme 2');
    const revenueAccountId = await accountId(orgA, '4100');

    await issueInvoice(agent, customer1, revenueAccountId, 1000, 100000, '2026-01-05', '2026-01-31');
    await issueInvoice(agent, customer2, revenueAccountId, 1000, 100000, '2026-01-06', '2026-01-31');
    await issueInvoice(agent, customer1, revenueAccountId, 1000, 60000, '2026-02-05', '2026-02-28');

    const res = await agent.get(COHORTS).query({ from: '2026-01-01', to: '2026-02-01' });

    const row = res.body.cohorts.matrix.rows[0];
    expect(row.cohortSize).toBe(2);
    expect(row.cells[1].activeCustomers).toBe(1);
    expect(row.cells[1].retentionBps).toBe(5000);
  });

  it('lets a VIEWER read', async () => {
    const viewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic Solo' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, viewer);
    await switchTo(agent, orgA);

    const res = await agent.get(COHORTS).query({ from: '2026-01-01', to: '2026-02-01' });
    expect(res.status).toBe(200);
  });

  it('never leaks another org into the result (cross-tenant, forward)', async () => {
    const agentA = await loginAgent(app, userA);
    const customerA = await createCustomer(agentA, 'Acme A');
    const revenueAccountA = await accountId(orgA, '4100');
    await issueInvoice(agentA, customerA, revenueAccountA, 1000, 100000, '2026-01-05', '2026-01-31');
    await issueInvoice(agentA, customerA, revenueAccountA, 1000, 60000, '2026-02-05', '2026-02-28');

    const agentB = await loginAgent(app, userB);
    const customerB = await createCustomer(agentB, 'Acme B');
    const revenueAccountB = await accountId(orgB, '4100');
    await issueInvoice(agentB, customerB, revenueAccountB, 1000, 9999900, '2026-01-05', '2026-01-31');

    const res = await agentA.get(COHORTS).query({ from: '2026-01-01', to: '2026-02-01' });

    const rows = res.body.cohorts.matrix.rows as { cohortSize: number; customerIds: string[] }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cohortSize).toBe(1);
    expect(rows[0]?.customerIds).not.toContain(customerB);
  });

  it('never leaks the other way (cross-tenant, reverse)', async () => {
    const agentA = await loginAgent(app, userA);
    const customerA = await createCustomer(agentA, 'Acme A');
    const revenueAccountA = await accountId(orgA, '4100');
    await issueInvoice(agentA, customerA, revenueAccountA, 1000, 100000, '2026-01-05', '2026-01-31');

    const agentB = await loginAgent(app, userB);
    const customerB = await createCustomer(agentB, 'Acme B');
    const revenueAccountB = await accountId(orgB, '4100');
    await issueInvoice(agentB, customerB, revenueAccountB, 1000, 9999900, '2026-01-05', '2026-01-31');

    const res = await agentB.get(COHORTS).query({ from: '2026-01-01', to: '2026-02-01' });

    const rows = res.body.cohorts.matrix.rows as { cohortSize: number; cells: { netRevenueCents: number }[] }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cohortSize).toBe(1);
    expect(rows[0]?.cells[0]?.netRevenueCents).toBe(9999900);
  });
});
