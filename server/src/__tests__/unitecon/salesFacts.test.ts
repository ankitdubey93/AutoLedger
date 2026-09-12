import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import * as reportService from '../../services/ledger-core/reportService.js';
import { ApiError } from '../../utils/apiError.js';

/**
 * reportService's UnitEcon sales bridge (Phase 14) — customerRevenueByMonth
 * and productLineSalesByMonth. Integration tier, real PostgreSQL: seeds via
 * the HTTP API, then calls the service functions directly.
 */

const app = createApp();
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

async function createCustomer(agent: Agent, name = 'Acme Co'): Promise<string> {
  const res = await agent.post(CUSTOMERS).send({ name });
  return res.body.customer.id as string;
}

function invoicePayload(overrides: {
  customerId: string;
  revenueAccountId: string;
  quantityMilli?: number;
  unitPriceCents?: number;
  issueDate?: string;
  dueDate?: string;
}) {
  return {
    customerId: overrides.customerId,
    issueDate: overrides.issueDate ?? '2026-06-01',
    dueDate: overrides.dueDate ?? '2026-06-30',
    notes: null,
    paymentTerms: null,
    lines: [
      {
        description: 'Widgets',
        quantityMilli: overrides.quantityMilli ?? 2000,
        unitPriceCents: overrides.unitPriceCents ?? 500,
        revenueAccountId: overrides.revenueAccountId,
        taxRateBp: 0,
      },
    ],
  };
}

async function issueInvoice(
  agent: Agent,
  customerId: string,
  revenueAccountId: string,
  overrides: { quantityMilli?: number; unitPriceCents?: number; issueDate?: string; dueDate?: string } = {},
): Promise<{ invoiceId: string; baseSubtotalCents: number }> {
  const created = await agent
    .post(INVOICES)
    .send(invoicePayload({ customerId, revenueAccountId, ...overrides }));
  const invoiceId = created.body.invoice.id as string;
  const issued = await agent.post(`${INVOICES}/${invoiceId}/issue`).send({});
  return { invoiceId, baseSubtotalCents: issued.body.invoice.baseSubtotalCents as number };
}

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userB.orgId;
});

afterAll(closePool);

describe('reportService.customerRevenueByMonth', () => {
  it('sums only ISSUED invoices', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const revenueAccountId = await accountId(orgA, '4100');

    const { baseSubtotalCents } = await issueInvoice(agent, customerId, revenueAccountId);

    // A second, DRAFT invoice for the same customer/month must not contribute.
    await agent.post(INVOICES).send(invoicePayload({ customerId, revenueAccountId }));

    const rows = await reportService.customerRevenueByMonth(orgA, '2026-06-01', '2026-06-30');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.netRevenueCents).toBe(baseSubtotalCents);
    expect(rows[0]?.customerId).toBe(customerId);
  });

  it('excludes a VOID invoice', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const revenueAccountId = await accountId(orgA, '4100');

    const { invoiceId } = await issueInvoice(agent, customerId, revenueAccountId);
    await agent.post(`${INVOICES}/${invoiceId}/void`).send({});

    const rows = await reportService.customerRevenueByMonth(orgA, '2026-06-01', '2026-06-30');

    expect(rows).toHaveLength(0);
  });

  it('produces two rows across two months, ascending by month', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const revenueAccountId = await accountId(orgA, '4100');

    await issueInvoice(agent, customerId, revenueAccountId, {
      issueDate: '2026-06-01',
      dueDate: '2026-06-30',
    });
    await issueInvoice(agent, customerId, revenueAccountId, {
      issueDate: '2026-07-01',
      dueDate: '2026-07-31',
    });

    const rows = await reportService.customerRevenueByMonth(orgA, '2026-06-01', '2026-07-31');

    expect(rows).toHaveLength(2);
    expect(rows[0]?.month).toBe('2026-06-01');
    expect(rows[1]?.month).toBe('2026-07-01');
  });

  it('never leaks another org into the result (cross-tenant)', async () => {
    const agentA = await loginAgent(app, userA);
    const customerA = await createCustomer(agentA, 'Acme A');
    const revenueAccountA = await accountId(orgA, '4100');
    const { baseSubtotalCents } = await issueInvoice(agentA, customerA, revenueAccountA);

    const agentB = await loginAgent(app, userB);
    const customerB = await createCustomer(agentB, 'Acme B');
    const revenueAccountB = await accountId(orgB, '4100');
    await issueInvoice(agentB, customerB, revenueAccountB, {
      quantityMilli: 1000,
      unitPriceCents: 9999900,
    });

    const rowsA = await reportService.customerRevenueByMonth(orgA, '2026-06-01', '2026-06-30');

    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]?.customerId).toBe(customerA);
    expect(rowsA[0]?.netRevenueCents).toBe(baseSubtotalCents);
  });

  it('throws 422 when from is after to', async () => {
    await expect(reportService.customerRevenueByMonth(orgA, '2026-07-01', '2026-06-01')).rejects.toMatchObject(
      { status: 422, message: 'from must not be after to' } satisfies Partial<ApiError>,
    );
  });
});

describe('reportService.productLineSalesByMonth', () => {
  it('aggregates quantity and net revenue by revenue account', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const revenueAccountId = await accountId(orgA, '4100');

    await issueInvoice(agent, customerId, revenueAccountId, { quantityMilli: 2000, unitPriceCents: 500 });
    await issueInvoice(agent, customerId, revenueAccountId, { quantityMilli: 3000, unitPriceCents: 500 });

    const org = await pool.query<{ base_currency: string }>(
      'SELECT base_currency FROM organizations WHERE id = $1',
      [orgA],
    );
    const baseCurrency = org.rows[0]?.base_currency ?? 'USD';

    const result = await reportService.productLineSalesByMonth(
      orgA,
      baseCurrency,
      [revenueAccountId],
      '2026-06-01',
      '2026-06-30',
    );

    // netCents per line = scaleCents(unitPriceCents, quantityMilli, 1000):
    // 500 * 2000/1000 = 1000, and 500 * 3000/1000 = 1500 -> 2500 total.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.quantityMilli).toBe(5000);
    expect(result.rows[0]?.netRevenueCents).toBe(2500);
    expect(result.excludedForeignCurrencyInvoices).toBe(0);
  });

  it('omits an account not in revenueAccountIds', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const revenueAccountId4100 = await accountId(orgA, '4100');
    const revenueAccountId4200 = await accountId(orgA, '4200');

    await issueInvoice(agent, customerId, revenueAccountId4200, { quantityMilli: 1000, unitPriceCents: 500 });

    const org = await pool.query<{ base_currency: string }>(
      'SELECT base_currency FROM organizations WHERE id = $1',
      [orgA],
    );
    const baseCurrency = org.rows[0]?.base_currency ?? 'USD';

    const result = await reportService.productLineSalesByMonth(
      orgA,
      baseCurrency,
      [revenueAccountId4100],
      '2026-06-01',
      '2026-06-30',
    );

    expect(result.rows).toHaveLength(0);
  });

  it('returns empty with no query when revenueAccountIds is empty', async () => {
    const result = await reportService.productLineSalesByMonth(orgA, 'USD', [], '2026-06-01', '2026-06-30');

    expect(result).toEqual({ rows: [], excludedForeignCurrencyInvoices: 0 });
  });

  it('never leaks another org lines on the same account code (cross-tenant)', async () => {
    const agentA = await loginAgent(app, userA);
    const customerA = await createCustomer(agentA, 'Acme A');
    const revenueAccountA = await accountId(orgA, '4100');
    await issueInvoice(agentA, customerA, revenueAccountA, { quantityMilli: 2000, unitPriceCents: 500 });

    const agentB = await loginAgent(app, userB);
    const customerB = await createCustomer(agentB, 'Acme B');
    const revenueAccountB = await accountId(orgB, '4100');
    await issueInvoice(agentB, customerB, revenueAccountB, {
      quantityMilli: 1000,
      unitPriceCents: 9999900,
    });

    const orgRow = await pool.query<{ base_currency: string }>(
      'SELECT base_currency FROM organizations WHERE id = $1',
      [orgA],
    );
    const baseCurrency = orgRow.rows[0]?.base_currency ?? 'USD';

    const result = await reportService.productLineSalesByMonth(
      orgA,
      baseCurrency,
      [revenueAccountA],
      '2026-06-01',
      '2026-06-30',
    );

    // netCents = scaleCents(500, 2000, 1000) = 1000.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.quantityMilli).toBe(2000);
    expect(result.rows[0]?.netRevenueCents).toBe(1000);
  });

  it('throws 422 when from is after to', async () => {
    await expect(
      reportService.productLineSalesByMonth(orgA, 'USD', ['00000000-0000-0000-0000-000000000000'], '2026-07-01', '2026-06-01'),
    ).rejects.toMatchObject({ status: 422, message: 'from must not be after to' } satisfies Partial<ApiError>);
  });
});
