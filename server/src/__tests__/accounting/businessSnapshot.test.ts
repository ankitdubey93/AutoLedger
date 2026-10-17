import type { Response } from 'superagent';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { snapshotTrendWindows } from '../../services/accounting/businessSnapshotService.js';
import type { BusinessSnapshot } from '../../types/accounting.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId, createCustomer, issueInvoice } from '../helpers/accountingFixtures.js';
import type { Agent } from '../helpers/accountingFixtures.js';

/**
 * Business snapshot (Phase 47). Integration tier, real PostgreSQL. Every
 * figure is hand-computed from the J1-J5 ledger below; the snapshot must tie
 * to the balance sheet and P&L; nothing crosses tenants.
 */

const app = createApp();
const REPORTS = '/api/v1/reports';
const FROM = '2026-09-01';
const TO = '2026-09-30';

function binary(res: Response, cb: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

let userA: SeededUser;
let orgA: string;
let agentA: Agent;
let agentB: Agent;

async function snapshot(agent: Agent): Promise<BusinessSnapshot> {
  const res = await agent.get(`${REPORTS}/business-snapshot`).query({ from: FROM, to: TO });
  expect(res.status).toBe(200);
  return res.body as BusinessSnapshot;
}

async function postManual(lines: { code: string; debit?: number; credit?: number }[]): Promise<void> {
  const res = await agentA.post('/api/v1/manual-journals').send({
    narration: 'Snapshot fixture',
    entryDate: '2026-09-15',
    action: 'post',
    lines: await Promise.all(
      lines.map(async (l) => ({
        accountId: await accountId(orgA, l.code),
        description: null,
        debitCents: l.debit ?? 0,
        creditCents: l.credit ?? 0,
      })),
    ),
  });
  if (res.status !== 201) throw new Error(`fixture: manual journal failed ${res.status} ${JSON.stringify(res.body)}`);
}

async function seedBase(): Promise<void> {
  await postManual([{ code: '1500', debit: 600000 }, { code: '3100', credit: 600000 }]);
  await postManual([{ code: '1130', debit: 400000 }, { code: '2510', credit: 400000 }]);
  await postManual([{ code: '1130', debit: 300000 }, { code: '4100', credit: 300000 }]);
  await postManual([{ code: '5100', debit: 120000 }, { code: '2120', credit: 120000 }]);
  await postManual([{ code: '6100', debit: 100000 }, { code: '1590', credit: 100000 }]);
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  const userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
});

afterAll(closePool);

describe('GET /reports/business-snapshot', () => {
  it('position and performance from a hand-computed ledger', async () => {
    await seedBase();
    const res = await agentA.get(`${REPORTS}/business-snapshot`).query({ from: FROM, to: TO });
    expect(res.status).toBe(200);
    const s = res.body as BusinessSnapshot;

    expect(s.position.current).toEqual({
      asOf: '2026-09-30',
      currentAssetsCents: 700000,
      nonCurrentAssetsCents: 500000,
      totalAssetsCents: 1200000,
      currentLiabilitiesCents: 120000,
      nonCurrentLiabilitiesCents: 400000,
      totalLiabilitiesCents: 520000,
      netWorthCents: 680000,
      workingCapitalCents: 580000,
    });
    expect(s.performance.current).toEqual({
      revenueCents: 300000,
      costOfSalesCents: 120000,
      grossProfitCents: 180000,
      operatingExpensesCents: 100000,
      netIncomeCents: 80000,
    });
    expect(s.priorPeriod).toEqual({ from: '2026-08-01', to: '2026-08-31' });
  });

  it('ratios in bp', async () => {
    await seedBase();
    const s = await snapshot(agentA);

    const current = Object.fromEntries(s.ratios.map((r) => [r.key, r.current.valueBp]));
    expect(current).toEqual({
      GROSS_MARGIN: 6000,
      CURRENT_RATIO: 58333,
      DEBT_RATIO: 4333,
      DEBT_TO_EQUITY: 7647,
      WORKING_CAPITAL_TO_TOTAL_ASSETS: 4833,
      FIXED_ASSETS_TO_NET_WORTH: 7353,
      CURRENT_LIABILITIES_TO_NET_WORTH: 1765,
    });
    for (const r of s.ratios) {
      expect(r.prior).toEqual({ valueBp: null, reason: 'DENOMINATOR_ZERO' });
    }
  });

  it('ties to the balance sheet and P&L', async () => {
    await seedBase();
    const s = await snapshot(agentA);

    const bs = await agentA.get(`${REPORTS}/balance-sheet`).query({ asOf: TO });
    expect(bs.status).toBe(200);
    expect(bs.body.assets.totalCents).toBe(s.position.current.totalAssetsCents);
    expect(bs.body.liabilities.totalCents).toBe(s.position.current.totalLiabilitiesCents);
    expect(bs.body.equity.totalCents).toBe(s.position.current.netWorthCents);

    const pnl = await agentA.get(`${REPORTS}/profit-and-loss`).query({ from: FROM, to: TO });
    expect(pnl.status).toBe(200);
    expect(pnl.body.grossProfitCents).toBe(s.performance.current.grossProfitCents);
  });

  it('override moves an account between classes', async () => {
    await seedBase();
    const res = await agentA
      .patch(`/api/v1/accounts/${await accountId(orgA, '1130')}`)
      .send({ balanceSheetClass: 'NON_CURRENT' });
    expect(res.status).toBe(200);
    expect(res.body.account.balanceSheetClass).toBe('NON_CURRENT');

    const s = await snapshot(agentA);
    expect(s.position.current.currentAssetsCents).toBe(0);
    expect(s.position.current.nonCurrentAssetsCents).toBe(1200000);
    const cr = s.ratios.find((r) => r.key === 'CURRENT_RATIO');
    expect(cr?.current.valueBp).toBe(0);
  });

  it('override refused on revenue', async () => {
    const res = await agentA
      .patch(`/api/v1/accounts/${await accountId(orgA, '4100')}`)
      .send({ balanceSheetClass: 'CURRENT' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Only asset and liability accounts have a balance sheet class');
  });

  it('DB check', async () => {
    await expect(
      pool.query("UPDATE accounts SET balance_sheet_class = 'CURRENT' WHERE code = '3100' AND org_id = $1", [orgA]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('negative net worth', async () => {
    await seedBase();
    await postManual([{ code: '6100', debit: 800000 }, { code: '2120', credit: 800000 }]);
    const s = await snapshot(agentA);

    expect(s.position.current.netWorthCents).toBe(-120000);
    for (const key of ['DEBT_TO_EQUITY', 'FIXED_ASSETS_TO_NET_WORTH', 'CURRENT_LIABILITIES_TO_NET_WORTH']) {
      expect(s.ratios.find((r) => r.key === key)?.current).toEqual({
        valueBp: null,
        reason: 'DENOMINATOR_NEGATIVE',
      });
    }
  });

  it('empty organization', async () => {
    const s = await snapshot(agentA);

    const { asOf: _asOf, ...amounts } = s.position.current;
    for (const v of Object.values(amounts)) expect(v).toBe(0);
    expect(s.trend.length).toBe(12);
    for (const r of s.ratios) expect(r.current.valueBp).toBeNull();
  });

  it('trend ends at the period', async () => {
    await seedBase();
    const s = await snapshot(agentA);

    expect(s.trend.length).toBe(12);
    expect(s.trend[11]).toMatchObject({
      month: '2026-09',
      asOf: '2026-09-30',
      revenueCents: 300000,
      costOfSalesCents: 120000,
      grossProfitCents: 180000,
      grossMarginBp: 6000,
      currentRatioBp: 58333,
    });
    expect(s.trend[0]?.month).toBe('2025-10');
    expect(s.trend[10]?.revenueCents).toBe(0);
  });

  it('aging matches the aging reports', async () => {
    const customerId = await createCustomer(agentA, 'Acme');
    await issueInvoice(agentA, orgA, customerId, 50000, '2026-09-05', '2026-09-20');
    const s = await snapshot(agentA);

    const ar = await agentA.get(`${REPORTS}/ar-aging`).query({ asOf: TO });
    expect(ar.status).toBe(200);
    expect(s.receivables.totalOutstandingCents).toBe(ar.body.totalOutstandingCents);
    expect(s.receivables.totalOutstandingCents).toBeGreaterThan(0);
    expect(s.receivables.buckets.length).toBe(5);
    expect(s.payables.totalOutstandingCents).toBe(0);
  });

  it('exports', async () => {
    await seedBase();
    for (const format of ['csv', 'xlsx', 'pdf']) {
      const res = await agentA
        .get(`${REPORTS}/business-snapshot`)
        .query({ from: FROM, to: TO, format })
        .buffer(true)
        .parse(binary);
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('business-snapshot-2026-09-01-2026-09-30');
      if (format === 'csv') {
        const text = (res.body as Buffer).toString('utf8');
        expect(text).toContain('Current ratio');
        expect(text).toContain('5.83×');
      }
    }

    const bad = await agentA.get(`${REPORTS}/business-snapshot`).query({ from: FROM, to: TO, format: 'doc' });
    expect(bad.status).toBe(400);
  });

  it('bad window', async () => {
    const res = await agentA.get(`${REPORTS}/business-snapshot`).query({ from: '2026-10-01', to: '2026-09-01' });
    expect(res.status).toBe(422);
  });

  it('cross-tenant', async () => {
    await seedBase();
    const s = await snapshot(agentB);

    expect(s.position.current.totalAssetsCents).toBe(0);
    expect(s.performance.current.revenueCents).toBe(0);
  });

  it('snapshotTrendWindows', () => {
    const w = snapshotTrendWindows('2026-09-15');
    expect(w[0]).toEqual({ month: '2025-10', from: '2025-10-01', to: '2025-10-31' });
    expect(w[11]).toEqual({ month: '2026-09', from: '2026-09-01', to: '2026-09-15' });

    const m = snapshotTrendWindows('2026-03-31');
    expect(m[11]?.to).toBe('2026-03-31');
    expect(m[10]?.to).toBe('2026-02-28');
  });
});
