import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId } from '../helpers/accountingFixtures.js';

/**
 * The taxable payments annual report (Phase 49h). Integration tier.
 *
 * The central claims: it counts what was paid in the financial year, on a cash
 * basis whatever the GST basis; only flagged vendors appear; missing details
 * block recording it as lodged; and a recorded year does not move afterwards.
 */

const app = createApp();
const ACTIVATE = { gst: { registered: true, basis: 'ACCRUAL', basCycle: 'QUARTERLY', basMethod: 'FULL' }, timezone: 'Australia/Sydney' };
const ABN = '51 824 753 556';

type Agent = Awaited<ReturnType<typeof loginAgent>>;
let user: SeededUser;
let agent: Agent;

async function vendor(body: Record<string, unknown>): Promise<string> {
  const res = await agent.post('/api/v1/vendors').send(body);
  if (res.status !== 201) throw new Error(`fixture: ${res.text}`);
  return res.body.vendor.id as string;
}

async function bill(vendorId: string, cents: number, billDate: string, code = 'P_GST'): Promise<string> {
  const created = await agent.post('/api/v1/bills').send({
    vendorId,
    vendorReference: `R-${String(Math.random())}`,
    billDate,
    dueDate: '2026-12-31',
    notes: null,
    paymentTerms: null,
    lines: [{ description: 'Labour', quantityMilli: 1000, unitPriceCents: cents, expenseAccountId: await accountId(user.orgId, '6200'), taxCode: code }],
  });
  if (created.status !== 201) throw new Error(`fixture: ${created.text}`);
  const id = created.body.bill.id as string;
  await agent.post(`/api/v1/bills/${id}/submit`).send({});
  const approved = await agent.post(`/api/v1/bills/${id}/approve`).send({});
  if (approved.status !== 200) throw new Error(`fixture: ${approved.text}`);
  return id;
}

async function pay(vendorId: string, billId: string, amountCents: number, paymentDate: string): Promise<void> {
  const res = await agent.post('/api/v1/payments').send({
    direction: 'PAY',
    paymentDate,
    amountCents,
    cashAccountId: await accountId(user.orgId, '1110'),
    vendorId,
    reference: 'P',
    allocations: [{ invoiceId: null, billId, amountCents }],
  });
  if (res.status !== 201) throw new Error(`fixture: ${res.text}`);
}

beforeEach(async () => {
  await resetTables();
  user = await createUserWithOrg({ label: 'a' });
  agent = await loginAgent(app, user);
  expect((await agent.post('/api/v1/settings/region/australia').send(ACTIVATE)).status).toBe(200);
});

afterAll(async () => {
  await closePool();
});

describe('the report', () => {
  it('counts only what flagged vendors were paid in the year, whatever the GST basis', async () => {
    const flagged = await vendor({ name: 'Sparks Electrical', taxNumber: ABN, billingAddress: '1 Quay St', tparReportable: true });
    const unflagged = await vendor({ name: 'Paper Co' });

    const inYear = await bill(flagged, 100_000, '2026-03-01'); // $1,100 with GST
    await pay(flagged, inYear, 55_000, '2026-04-01'); // half paid in FY2026
    await pay(flagged, inYear, 55_000, '2026-07-05'); // half paid in FY2027
    const unpaid = await bill(flagged, 900_000, '2026-05-01');
    expect(unpaid).toBeTruthy();
    const other = await bill(unflagged, 50_000, '2026-03-01');
    await pay(unflagged, other, 55_000, '2026-03-02');

    const fy26 = await agent.get('/api/v1/tpar/2026');
    expect(fy26.status).toBe(200);
    expect(fy26.body.report).toMatchObject({ from: '2025-07-01', to: '2026-06-30', dueDate: '2026-08-28', totalGrossCents: 55_000, totalGstCents: 5_000 });
    expect(fy26.body.report.rows).toEqual([
      { vendorId: flagged, name: 'Sparks Electrical', abn: ABN, address: '1 Quay St', grossPaidCents: 55_000, gstCents: 5_000, problems: [] },
    ]);

    const fy27 = await agent.get('/api/v1/tpar/2027');
    expect(fy27.body.report.totalGrossCents).toBe(55_000);
  });

  it('includes a contractor who charges no GST', async () => {
    const small = await vendor({ name: 'Solo Cleaner', taxNumber: ABN, billingAddress: 'x', tparReportable: true });
    const b = await bill(small, 20_000, '2026-03-01', 'P_FREE');
    await pay(small, b, 20_000, '2026-03-02');
    expect((await agent.get('/api/v1/tpar/2026')).body.report.rows[0]).toMatchObject({ grossPaidCents: 20_000, gstCents: 0 });
  });

  it('points out missing details', async () => {
    const noDetails = await vendor({ name: 'Mystery Co', tparReportable: true });
    const b = await bill(noDetails, 1_000, '2026-03-01');
    await pay(noDetails, b, 1_100, '2026-03-02');
    const res = await agent.get('/api/v1/tpar/2026');
    expect(res.body.report.rows[0].problems).toEqual(['No ABN', 'No address']);
    const refused = await agent.post('/api/v1/tpar/2026/lodge').send({ lodgedOn: '2026-08-01' });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toContain('Mystery Co');
  });

  it('exports', async () => {
    const v = await vendor({ name: 'Sparks', taxNumber: ABN, billingAddress: '1 Quay St\nSydney', tparReportable: true });
    const b = await bill(v, 1_000, '2026-03-01');
    await pay(v, b, 1_100, '2026-03-02');
    const csv = await agent.get('/api/v1/tpar/2026?format=csv');
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Sparks');
    expect(csv.text).toContain('1 Quay St, Sydney');
    expect((await agent.get('/api/v1/tpar/2026?format=pdf')).status).toBe(200);
  });

  it('refuses a nonsense year', async () => {
    expect((await agent.get('/api/v1/tpar/abc')).status).toBe(400);
    expect((await agent.get('/api/v1/tpar/1800')).status).toBe(400);
  });
});

describe('recording it as lodged', () => {
  it('stores the report as it stood, once', async () => {
    const v = await vendor({ name: 'Sparks', taxNumber: ABN, billingAddress: 'x', tparReportable: true });
    const b = await bill(v, 1_000, '2026-03-01');
    await pay(v, b, 1_100, '2026-03-02');

    expect((await agent.post('/api/v1/tpar/2026/lodge').send({ lodgedOn: '2026-06-01' })).status).toBe(422);
    const lodged = await agent.post('/api/v1/tpar/2026/lodge').send({ lodgedOn: '2026-08-20', atoReference: 'T1' });
    expect(lodged.status).toBe(200);
    expect(lodged.body.report.lodgment).toEqual({ lodgedOn: '2026-08-20', atoReference: 'T1' });

    // Later edits do not change what was reported.
    await agent.patch(`/api/v1/vendors/${v}`).send({ name: 'Renamed' });
    const b2 = await bill(v, 5_000, '2026-03-05');
    await pay(v, b2, 5_500, '2026-03-06');
    const read = await agent.get('/api/v1/tpar/2026');
    expect(read.body.report.rows[0]).toMatchObject({ name: 'Sparks', grossPaidCents: 1_100 });

    expect((await agent.post('/api/v1/tpar/2026/lodge').send({ lodgedOn: '2026-08-21' })).status).toBe(409);
  });
});

describe('access', () => {
  it('is refused to a generic organization, and shows nothing across tenants', async () => {
    const v = await vendor({ name: 'Sparks', taxNumber: ABN, billingAddress: 'x', tparReportable: true });
    const b = await bill(v, 1_000, '2026-03-01');
    await pay(v, b, 1_100, '2026-03-02');

    const generic = await loginAgent(app, await createUserWithOrg({ label: 'g' }));
    expect((await generic.get('/api/v1/tpar/2026')).status).toBe(403);

    const other = await loginAgent(app, await createUserWithOrg({ label: 'o' }));
    await other.post('/api/v1/settings/region/australia').send(ACTIVATE);
    expect((await other.get('/api/v1/tpar/2026')).body.report.rows).toEqual([]);
    const { rows } = await pool.query('SELECT 1 FROM tpar_returns');
    expect(rows).toHaveLength(0);
  });
});
