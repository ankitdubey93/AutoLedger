import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * unitecon PVM API (Phase 14). Integration tier, real PostgreSQL. Includes
 * this module's cross-tenant isolation suite (rule 15).
 */

const app = createApp();
const PVM = '/api/v1/unitecon/pvm';
const PRODUCT_LINES = '/api/v1/unitecon/product-lines';
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
): Promise<string> {
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
  return invoiceId;
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

describe('unitecon PVM API', () => {
  it('requires all four period params and rejects malformed or reversed ones', async () => {
    const agent = await loginAgent(app, userA);

    const missing = await agent
      .get(PVM)
      .query({ baseFrom: '2026-01-01', baseTo: '2026-01-01', compareFrom: '2026-02-01' });
    expect(missing.status).toBe(400);

    const malformed = await agent.get(PVM).query({
      baseFrom: '2026-01-15',
      baseTo: '2026-01-01',
      compareFrom: '2026-02-01',
      compareTo: '2026-02-01',
    });
    expect(malformed.status).toBe(400);

    const reversed = await agent.get(PVM).query({
      baseFrom: '2026-02-01',
      baseTo: '2026-01-01',
      compareFrom: '2026-02-01',
      compareTo: '2026-02-01',
    });
    expect(reversed.status).toBe(422);
  });

  it('422s when no product lines are configured', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(PVM).query({
      baseFrom: '2026-01-01',
      baseTo: '2026-01-01',
      compareFrom: '2026-02-01',
      compareTo: '2026-02-01',
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('at least one product line');
  });

  it('hand-computed happy path', async () => {
    const agent = await loginAgent(app, userA);
    const revenueAccountId = await accountId(orgA, '4100');
    await agent.post(PRODUCT_LINES).send({ revenueAccountId, name: 'Widgets', unitLabel: 'unit' });

    const customerId = await createCustomer(agent, 'Acme');
    await issueInvoice(agent, customerId, revenueAccountId, 10000, 10000, '2026-01-05', '2026-01-31');
    await issueInvoice(agent, customerId, revenueAccountId, 20000, 11000, '2026-02-05', '2026-02-28');

    const res = await agent.get(PVM).query({
      baseFrom: '2026-01-01',
      baseTo: '2026-01-01',
      compareFrom: '2026-02-01',
      compareTo: '2026-02-01',
    });

    expect(res.status).toBe(200);
    const row = res.body.pvm.report.rows[0];
    const totals = res.body.pvm.report.totals;

    expect(row.baseQuantityMilli).toBe(10000);
    expect(row.compareQuantityMilli).toBe(20000);
    expect(row.baseNetCents).toBe(100000);
    expect(row.compareNetCents).toBe(220000);
    expect(row.baseUnitPriceCents).toBe(10000);
    expect(row.compareUnitPriceCents).toBe(11000);
    expect(row.totalVarianceCents).toBe(120000);
    expect(row.priceVarianceCents).toBe(20000);
    expect(row.volumeVarianceCents).toBe(100000);
    expect(row.mixVarianceCents).toBe(0);
    expect(
      totals.priceVarianceCents + totals.volumeVarianceCents + totals.mixVarianceCents,
    ).toBe(totals.totalVarianceCents);
  });

  it('excludes DRAFT and VOID invoices', async () => {
    const agent = await loginAgent(app, userA);
    const revenueAccountId = await accountId(orgA, '4100');
    await agent.post(PRODUCT_LINES).send({ revenueAccountId, name: 'Widgets', unitLabel: 'unit' });

    const customerId = await createCustomer(agent, 'Acme');
    await issueInvoice(agent, customerId, revenueAccountId, 10000, 10000, '2026-01-05', '2026-01-31');
    await issueInvoice(agent, customerId, revenueAccountId, 20000, 11000, '2026-02-05', '2026-02-28');

    // A DRAFT invoice in the comparison month, never issued.
    await agent.post(INVOICES).send({
      customerId,
      issueDate: '2026-02-10',
      dueDate: '2026-02-28',
      notes: null,
      paymentTerms: null,
      lines: [{ description: 'Draft', quantityMilli: 5000, unitPriceCents: 999, revenueAccountId, taxRateBp: 0 }],
    });

    // A VOIDed invoice in the comparison month.
    const voidedId = await issueInvoice(
      agent,
      customerId,
      revenueAccountId,
      3000,
      777,
      '2026-02-12',
      '2026-02-28',
    );
    await agent.post(`${INVOICES}/${voidedId}/void`).send({});

    const res = await agent.get(PVM).query({
      baseFrom: '2026-01-01',
      baseTo: '2026-01-01',
      compareFrom: '2026-02-01',
      compareTo: '2026-02-01',
    });

    const row = res.body.pvm.report.rows[0];
    expect(row.compareQuantityMilli).toBe(20000);
    expect(row.compareNetCents).toBe(220000);
  });

  it('an unregistered revenue account is invisible to the report', async () => {
    const agent = await loginAgent(app, userA);
    const revenueAccountId4100 = await accountId(orgA, '4100');
    const revenueAccountId4200 = await accountId(orgA, '4200');
    await agent.post(PRODUCT_LINES).send({ revenueAccountId: revenueAccountId4100, name: 'Widgets', unitLabel: 'unit' });

    const customerId = await createCustomer(agent, 'Acme');
    await issueInvoice(agent, customerId, revenueAccountId4100, 10000, 10000, '2026-01-05', '2026-01-31');
    await issueInvoice(agent, customerId, revenueAccountId4200, 99999, 99999, '2026-01-06', '2026-01-31');
    await issueInvoice(agent, customerId, revenueAccountId4100, 20000, 11000, '2026-02-05', '2026-02-28');

    const res = await agent.get(PVM).query({
      baseFrom: '2026-01-01',
      baseTo: '2026-01-01',
      compareFrom: '2026-02-01',
      compareTo: '2026-02-01',
    });

    expect(res.body.pvm.report.rows).toHaveLength(1);
    const row = res.body.pvm.report.rows[0];
    expect(row.baseNetCents).toBe(100000);
  });

  it('two product lines produce a decomposition where components always tie out', async () => {
    const agent = await loginAgent(app, userA);
    const revenueAccountId4100 = await accountId(orgA, '4100');
    const revenueAccountId4200 = await accountId(orgA, '4200');
    await agent.post(PRODUCT_LINES).send({ revenueAccountId: revenueAccountId4100, name: 'Widgets', unitLabel: 'unit' });
    await agent.post(PRODUCT_LINES).send({ revenueAccountId: revenueAccountId4200, name: 'Services', unitLabel: 'hr' });

    const customerId = await createCustomer(agent, 'Acme');
    await issueInvoice(agent, customerId, revenueAccountId4100, 10000, 10000, '2026-01-05', '2026-01-31');
    await issueInvoice(agent, customerId, revenueAccountId4200, 10000, 20000, '2026-01-06', '2026-01-31');
    await issueInvoice(agent, customerId, revenueAccountId4100, 5000, 10000, '2026-02-05', '2026-02-28');
    await issueInvoice(agent, customerId, revenueAccountId4200, 15000, 20000, '2026-02-06', '2026-02-28');

    const res = await agent.get(PVM).query({
      baseFrom: '2026-01-01',
      baseTo: '2026-01-01',
      compareFrom: '2026-02-01',
      compareTo: '2026-02-01',
    });

    expect(res.body.pvm.report.rows).toHaveLength(2);
    for (const row of res.body.pvm.report.rows) {
      expect(row.priceVarianceCents + row.volumeVarianceCents + row.mixVarianceCents).toBe(
        row.totalVarianceCents,
      );
    }
    const totals = res.body.pvm.report.totals;
    expect(totals.priceVarianceCents + totals.volumeVarianceCents + totals.mixVarianceCents).toBe(
      totals.totalVarianceCents,
    );
  });

  it('reports excludedForeignCurrencyInvoices as a present field, currently 0 for this fixture', async () => {
    // Foreign-currency invoice creation is not exercised by this fixture
    // (createInvoiceSchema's currencyCode is optional and defaults to base
    // currency) — the non-zero path is covered directly by
    // salesFacts.test.ts, which calls the reportService bridge function.
    const agent = await loginAgent(app, userA);
    const revenueAccountId = await accountId(orgA, '4100');
    await agent.post(PRODUCT_LINES).send({ revenueAccountId, name: 'Widgets', unitLabel: 'unit' });

    const customerId = await createCustomer(agent, 'Acme');
    await issueInvoice(agent, customerId, revenueAccountId, 10000, 10000, '2026-01-05', '2026-01-31');
    await issueInvoice(agent, customerId, revenueAccountId, 20000, 11000, '2026-02-05', '2026-02-28');

    const res = await agent.get(PVM).query({
      baseFrom: '2026-01-01',
      baseTo: '2026-01-01',
      compareFrom: '2026-02-01',
      compareTo: '2026-02-01',
    });

    expect(res.body.pvm.excludedForeignCurrencyInvoices).toBe(0);
  });

  it('lets a VIEWER read', async () => {
    const agent = await loginAgent(app, userA);
    const revenueAccountId = await accountId(orgA, '4100');
    await agent.post(PRODUCT_LINES).send({ revenueAccountId, name: 'Widgets', unitLabel: 'unit' });

    const viewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic Solo' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const viewerAgent = await loginAgent(app, viewer);
    await switchTo(viewerAgent, orgA);

    const res = await viewerAgent.get(PVM).query({
      baseFrom: '2026-01-01',
      baseTo: '2026-01-01',
      compareFrom: '2026-02-01',
      compareTo: '2026-02-01',
    });
    expect(res.status).toBe(200);
  });

  it('never leaks another org into the figures (cross-tenant)', async () => {
    const agentA = await loginAgent(app, userA);
    const revenueAccountIdA = await accountId(orgA, '4100');
    await agentA.post(PRODUCT_LINES).send({ revenueAccountId: revenueAccountIdA, name: 'Widgets', unitLabel: 'unit' });
    const customerA = await createCustomer(agentA, 'Acme A');
    await issueInvoice(agentA, customerA, revenueAccountIdA, 10000, 10000, '2026-01-05', '2026-01-31');
    await issueInvoice(agentA, customerA, revenueAccountIdA, 20000, 11000, '2026-02-05', '2026-02-28');

    const agentB = await loginAgent(app, userB);
    const revenueAccountIdB = await accountId(orgB, '4100');
    await agentB.post(PRODUCT_LINES).send({ revenueAccountId: revenueAccountIdB, name: 'Widgets', unitLabel: 'unit' });
    const customerB = await createCustomer(agentB, 'Acme B');
    await issueInvoice(agentB, customerB, revenueAccountIdB, 99999, 9999900, '2026-01-05', '2026-01-31');
    await issueInvoice(agentB, customerB, revenueAccountIdB, 99999, 9999900, '2026-02-05', '2026-02-28');

    const res = await agentA.get(PVM).query({
      baseFrom: '2026-01-01',
      baseTo: '2026-01-01',
      compareFrom: '2026-02-01',
      compareTo: '2026-02-01',
    });

    expect(res.body.pvm.report.rows).toHaveLength(1);
    const row = res.body.pvm.report.rows[0];
    expect(row.baseNetCents).toBe(100000);
    expect(row.compareNetCents).toBe(220000);
    expect(row.priceVarianceCents).toBe(20000);
    expect(row.volumeVarianceCents).toBe(100000);
    expect(row.mixVarianceCents).toBe(0);
  });
});
