import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * unitecon unit-economics API (Phase 14). Integration tier, real PostgreSQL.
 * Includes this module's cross-tenant isolation suite (rule 15).
 */

const app = createApp();
const UNIT_ECON = '/api/v1/unitecon/unit-economics';
const SETTINGS = '/api/v1/unitecon/settings';
const CUSTOMERS = '/api/v1/ledger-core/customers';
const INVOICES = '/api/v1/ledger-core/invoices';
const JOURNALS = '/api/v1/ledger-core/journals';

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
    lines: [{ description: 'Widgets', quantityMilli, unitPriceCents, revenueAccountId, taxRateBp: 0 }],
  });
  const invoiceId = created.body.invoice.id as string;
  await agent.post(`${INVOICES}/${invoiceId}/issue`).send({});
}

/** Posts a balanced manual journal entry debiting or crediting `accountId`
 *  against cash (1110), so `accountId`'s net debit activity moves by
 *  `signedAmountCents` (positive = debit, negative = credit). */
async function postToAccount(
  agent: Agent,
  orgId: string,
  accountId_: string,
  signedAmountCents: number,
  entryDate: string,
): Promise<void> {
  const cashId = await accountId(orgId, '1110');
  const amount = Math.abs(signedAmountCents);
  const lines =
    signedAmountCents >= 0
      ? [
          { accountId: accountId_, debitCents: amount, creditCents: 0 },
          { accountId: cashId, debitCents: 0, creditCents: amount },
        ]
      : [
          { accountId: accountId_, debitCents: 0, creditCents: amount },
          { accountId: cashId, debitCents: amount, creditCents: 0 },
        ];
  const res = await agent.post(JOURNALS).send({ entryDate, description: 'fixture', lines });
  if (res.status !== 201) throw new Error(`fixture: journal post failed: ${JSON.stringify(res.body)}`);
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

describe('unitecon unit-economics API', () => {
  it('requires from and to, and rejects a malformed month or a reversed range', async () => {
    const agent = await loginAgent(app, userA);

    expect((await agent.get(UNIT_ECON).query({ to: '2026-01-01' })).status).toBe(400);
    expect((await agent.get(UNIT_ECON).query({ from: '2026-01-15', to: '2026-01-01' })).status).toBe(400);
    expect(
      (await agent.get(UNIT_ECON).query({ from: '2026-03-01', to: '2026-01-01' })).status,
    ).toBe(422);
  });

  it('reports zero spend and zero CAC when no acquisition accounts are configured', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent, 'Acme');
    const revenueAccountId = await accountId(orgA, '4100');
    await issueInvoice(agent, customerId, revenueAccountId, 1000, 150000, '2026-01-05', '2026-01-31');

    const res = await agent.get(UNIT_ECON).query({ from: '2026-01-01', to: '2026-01-01' });

    expect(res.status).toBe(200);
    const row = res.body.unitEconomics.rows[0];
    expect(row.acquisitionSpendCents).toBe(0);
    expect(row.cacCents).toBe(0);
    expect(row.ltvToCacBps).toBeNull();
    expect(row.paybackMonths).toBeNull();
  });

  it('hand-computed happy path', async () => {
    const agent = await loginAgent(app, userA);
    const expenseId = await accountId(orgA, '6100');
    await agent.patch(SETTINGS).send({ grossMarginBps: 5000, acquisitionAccountIds: [expenseId] });

    await postToAccount(agent, orgA, expenseId, 200000, '2026-01-10');

    const customer1 = await createCustomer(agent, 'Acme 1');
    const customer2 = await createCustomer(agent, 'Acme 2');
    const revenueAccountId = await accountId(orgA, '4100');
    await issueInvoice(agent, customer1, revenueAccountId, 1000, 150000, '2026-01-05', '2026-01-31');
    await issueInvoice(agent, customer2, revenueAccountId, 1000, 150000, '2026-01-06', '2026-01-31');

    const res = await agent.get(UNIT_ECON).query({ from: '2026-01-01', to: '2026-01-01' });

    expect(res.status).toBe(200);
    const body = res.body.unitEconomics;
    expect(body.rows).toHaveLength(1);
    const row = body.rows[0];

    expect(row.newCustomers).toBe(2);
    expect(row.acquisitionSpendCents).toBe(200000);
    expect(row.cacCents).toBe(100000);
    expect(row.cumulativeRevenueCents).toBe(300000);
    expect(row.cumulativeGrossMarginCents).toBe(150000);
    expect(row.ltvCents).toBe(75000);
    expect(row.ltvToCacBps).toBe(7500);
    expect(row.paybackMonths).toBeNull();
    expect(row.observedMonths).toBe(1);

    expect(body.totalNewCustomers).toBe(2);
    expect(body.totalAcquisitionSpendCents).toBe(200000);
    expect(body.blendedCacCents).toBe(100000);
  });

  it('finds payback once cumulative margin per customer reaches CAC', async () => {
    const agent = await loginAgent(app, userA);
    const expenseId = await accountId(orgA, '6100');
    await agent.patch(SETTINGS).send({ grossMarginBps: 5000, acquisitionAccountIds: [expenseId] });
    await postToAccount(agent, orgA, expenseId, 200000, '2026-01-10');

    const customer1 = await createCustomer(agent, 'Acme 1');
    const customer2 = await createCustomer(agent, 'Acme 2');
    const revenueAccountId = await accountId(orgA, '4100');
    await issueInvoice(agent, customer1, revenueAccountId, 1000, 150000, '2026-01-05', '2026-01-31');
    await issueInvoice(agent, customer2, revenueAccountId, 1000, 150000, '2026-01-06', '2026-01-31');
    await issueInvoice(agent, customer1, revenueAccountId, 1000, 150000, '2026-02-05', '2026-02-28');
    await issueInvoice(agent, customer2, revenueAccountId, 1000, 150000, '2026-02-06', '2026-02-28');

    const res = await agent.get(UNIT_ECON).query({ from: '2026-01-01', to: '2026-03-01' });

    const row = res.body.unitEconomics.rows[0];
    expect(row.paybackMonths).toBe(1);
  });

  it('a credit on an acquisition account reduces net spend', async () => {
    const agent = await loginAgent(app, userA);
    const expenseId = await accountId(orgA, '6100');
    await agent.patch(SETTINGS).send({ grossMarginBps: 5000, acquisitionAccountIds: [expenseId] });
    await postToAccount(agent, orgA, expenseId, 200000, '2026-01-10');
    await postToAccount(agent, orgA, expenseId, -50000, '2026-01-15');

    const customer1 = await createCustomer(agent, 'Acme 1');
    const customer2 = await createCustomer(agent, 'Acme 2');
    const revenueAccountId = await accountId(orgA, '4100');
    await issueInvoice(agent, customer1, revenueAccountId, 1000, 150000, '2026-01-05', '2026-01-31');
    await issueInvoice(agent, customer2, revenueAccountId, 1000, 150000, '2026-01-06', '2026-01-31');

    const res = await agent.get(UNIT_ECON).query({ from: '2026-01-01', to: '2026-01-01' });

    const row = res.body.unitEconomics.rows[0];
    expect(row.acquisitionSpendCents).toBe(150000);
    expect(row.cacCents).toBe(75000);
  });

  it('rounds CAC half away from zero', async () => {
    const agent = await loginAgent(app, userA);
    const expenseId = await accountId(orgA, '6100');
    await agent.patch(SETTINGS).send({ acquisitionAccountIds: [expenseId] });
    await postToAccount(agent, orgA, expenseId, 100000, '2026-01-10');

    const c1 = await createCustomer(agent, 'C1');
    const c2 = await createCustomer(agent, 'C2');
    const c3 = await createCustomer(agent, 'C3');
    const revenueAccountId = await accountId(orgA, '4100');
    await issueInvoice(agent, c1, revenueAccountId, 1000, 100, '2026-01-05', '2026-01-31');
    await issueInvoice(agent, c2, revenueAccountId, 1000, 100, '2026-01-06', '2026-01-31');
    await issueInvoice(agent, c3, revenueAccountId, 1000, 100, '2026-01-07', '2026-01-31');

    const res = await agent.get(UNIT_ECON).query({ from: '2026-01-01', to: '2026-01-01' });
    // 100000 / 3 = 33333.33 -> half away from zero rounds to 33333.
    expect(res.body.unitEconomics.rows[0].cacCents).toBe(33333);
  });

  it('lets a VIEWER read', async () => {
    const viewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic Solo' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, viewer);
    await switchTo(agent, orgA);

    const res = await agent.get(UNIT_ECON).query({ from: '2026-01-01', to: '2026-01-01' });
    expect(res.status).toBe(200);
  });

  it('never leaks another org into the figures (cross-tenant)', async () => {
    const agentA = await loginAgent(app, userA);
    const expenseIdA = await accountId(orgA, '6100');
    await agentA.patch(SETTINGS).send({ grossMarginBps: 5000, acquisitionAccountIds: [expenseIdA] });
    await postToAccount(agentA, orgA, expenseIdA, 200000, '2026-01-10');
    const customer1 = await createCustomer(agentA, 'Acme 1');
    const customer2 = await createCustomer(agentA, 'Acme 2');
    const revenueAccountIdA = await accountId(orgA, '4100');
    await issueInvoice(agentA, customer1, revenueAccountIdA, 1000, 150000, '2026-01-05', '2026-01-31');
    await issueInvoice(agentA, customer2, revenueAccountIdA, 1000, 150000, '2026-01-06', '2026-01-31');

    const agentB = await loginAgent(app, userB);
    const expenseIdB = await accountId(orgB, '6100');
    await agentB.patch(SETTINGS).send({ acquisitionAccountIds: [expenseIdB] });
    await postToAccount(agentB, orgB, expenseIdB, 9999900, '2026-01-10');
    const customerB1 = await createCustomer(agentB, 'B1');
    const customerB2 = await createCustomer(agentB, 'B2');
    const customerB3 = await createCustomer(agentB, 'B3');
    const revenueAccountIdB = await accountId(orgB, '4100');
    await issueInvoice(agentB, customerB1, revenueAccountIdB, 1000, 9999900, '2026-01-05', '2026-01-31');
    await issueInvoice(agentB, customerB2, revenueAccountIdB, 1000, 9999900, '2026-01-05', '2026-01-31');
    await issueInvoice(agentB, customerB3, revenueAccountIdB, 1000, 9999900, '2026-01-05', '2026-01-31');

    const res = await agentA.get(UNIT_ECON).query({ from: '2026-01-01', to: '2026-01-01' });
    const row = res.body.unitEconomics.rows[0];

    expect(row.newCustomers).toBe(2);
    expect(row.acquisitionSpendCents).toBe(200000);
    expect(row.cacCents).toBe(100000);
    expect(row.cumulativeRevenueCents).toBe(300000);
    expect(row.ltvCents).toBe(75000);
    expect(row.ltvToCacBps).toBe(7500);
  });
});
