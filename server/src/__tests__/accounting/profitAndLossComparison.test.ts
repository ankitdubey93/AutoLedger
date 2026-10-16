import type { Response } from 'superagent';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import { createCustomer, issueInvoice } from '../helpers/accountingFixtures.js';
import type { Agent } from '../helpers/accountingFixtures.js';
import { readZip } from '../helpers/zipReader.js';

/**
 * Phase 45 — P&L comparison (MoM / QoQ / YoY). Integration tier, real
 * PostgreSQL. Org Alpha: invoices of 100.00 (2026-08-10), 300.00 (2026-09-10)
 * and 50.00 (2025-09-15), tax 0. Org Bravo holds nothing.
 */

const app = createApp();
const REPORTS = '/api/v1/reports';
const COMPARISON = `${REPORTS}/profit-and-loss/comparison`;

function binary(res: Response, cb: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

let agentA: Agent;
let agentB: Agent;

beforeEach(async () => {
  await resetTables();
  const userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  const userB = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  const customerId = await createCustomer(agentA, 'Northwind Traders');
  await issueInvoice(agentA, userA.orgId, customerId, 10000, '2026-08-10', '2026-09-10');
  await issueInvoice(agentA, userA.orgId, customerId, 30000, '2026-09-10', '2026-10-10');
  await issueInvoice(agentA, userA.orgId, customerId, 5000, '2025-09-15', '2025-10-15');
});

afterAll(closePool);

describe('profit and loss comparison', () => {
  it('MoM', async () => {
    const res = await agentA.get(`${COMPARISON}?from=2026-09-01&to=2026-09-30&compare=previousPeriod&periods=1`);
    expect(res.status).toBe(200);
    expect(res.body.periods[1]).toMatchObject({ from: '2026-08-01', to: '2026-08-31' });
    expect(res.body.revenue.totalsCents).toEqual([30000, 10000]);
    expect(res.body.revenue.variance).toEqual({ cents: 20000, bp: 20000 });
    expect(res.body.netIncomeCents).toEqual([30000, 10000]);
  });

  it('YoY', async () => {
    const res = await agentA.get(`${COMPARISON}?from=2026-09-01&to=2026-09-30&compare=samePeriodLastYear&periods=1`);
    expect(res.status).toBe(200);
    expect(res.body.revenue.totalsCents).toEqual([30000, 5000]);
  });

  it('QoQ', async () => {
    const res = await agentA.get(`${COMPARISON}?from=2026-07-01&to=2026-09-30&compare=previousPeriod&periods=1`);
    expect(res.status).toBe(200);
    expect(res.body.periods[1].from).toBe('2026-04-01');
    expect(res.body.revenue.totalsCents).toEqual([40000, 0]);
    expect(res.body.revenue.variance.bp).toBeNull();
  });

  it('ties to the single P&L', async () => {
    const res = await agentA.get(`${COMPARISON}?from=2026-09-01&to=2026-09-30&compare=previousPeriod&periods=2`);
    expect(res.status).toBe(200);
    const periods = res.body.periods as { from: string; to: string }[];
    expect(periods).toHaveLength(3);
    for (const [i, period] of periods.entries()) {
      const single = await agentA.get(`${REPORTS}/profit-and-loss?from=${period.from}&to=${period.to}`);
      expect(single.status).toBe(200);
      expect(res.body.netIncomeCents[i]).toBe(single.body.netIncomeCents);
    }
  });

  it('validation', async () => {
    const tooMany = await agentA.get(`${COMPARISON}?from=2026-09-01&to=2026-09-30&periods=12`);
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toBe('periods must be between 1 and 11');
    const badMode = await agentA.get(`${COMPARISON}?from=2026-09-01&to=2026-09-30&compare=x`);
    expect(badMode.status).toBe(400);
    expect(badMode.body.error).toBe('compare must be previousPeriod or samePeriodLastYear');
  });

  it('xlsx export', async () => {
    const res = await agentA
      .get(`${COMPARISON}?from=2026-09-01&to=2026-09-30&compare=previousPeriod&periods=1&format=xlsx`)
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(200);
    const sheet = readZip(res.body as Buffer).get('xl/worksheets/sheet1.xml')?.toString('utf8') ?? '';
    expect(sheet).toContain('Sep 2026');
    expect(sheet).toContain('Aug 2026');
  });

  it('cross-tenant', async () => {
    const res = await agentB.get(`${COMPARISON}?from=2026-09-01&to=2026-09-30&compare=previousPeriod&periods=1`);
    expect(res.status).toBe(200);
    expect(res.body.revenue.rows).toEqual([]);
  });
});
