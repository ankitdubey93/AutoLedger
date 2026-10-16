import type { Response } from 'superagent';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import { accountId, createCustomer, issueCreditNote, issueInvoice, postBill } from '../helpers/accountingFixtures.js';
import type { Agent } from '../helpers/accountingFixtures.js';
import { createVendor } from '../helpers/depositFixtures.js';
import { readZip } from '../helpers/zipReader.js';

/**
 * Sales and purchases by customer, vendor and item (Phase 45). Integration
 * tier, real PostgreSQL. Customer totals tie to the tax summary's output net;
 * item totals are allocated per line; nothing crosses tenants.
 */

const app = createApp();
const REPORTS = '/api/v1/reports';
const FROM = '2026-09-01';
const TO = '2026-09-30';

interface Row {
  key: string;
  label: string;
  code: string | null;
  quantityMilli: number | null;
  netCents: number;
  comparisonNetCents: number | null;
}
interface Report {
  rows: Row[];
  totalNetCents: number;
}

function binary(res: Response, cb: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

let orgA: string;
let agentA: Agent;
let agentB: Agent;
let acme: string;
let beta: string;
let itemId: string;

async function report(agent: Agent, kind: string, extra: Record<string, string> = {}): Promise<Report> {
  const res = await agent.get(`${REPORTS}/${kind}`).query({ from: FROM, to: TO, ...extra });
  expect(res.status).toBe(200);
  return res.body as Report;
}

beforeEach(async () => {
  await resetTables();
  const userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  const userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  acme = await createCustomer(agentA, 'Acme');
  beta = await createCustomer(agentA, 'Beta');

  const item = await agentA.post('/api/v1/items').send({ code: 'WID', name: 'Widget', kind: 'SERVICE' });
  if (item.status !== 201) throw new Error(`fixture: item create failed ${item.status} ${item.text}`);
  itemId = item.body.item.id as string;

  const created = await agentA.post('/api/v1/invoices').send({
    customerId: acme,
    issueDate: '2026-09-05',
    dueDate: '2026-12-31',
    notes: null,
    paymentTerms: null,
    lines: [
      {
        description: 'Widgets',
        quantityMilli: 3000,
        unitPriceCents: 10000,
        revenueAccountId: await accountId(orgA, '4100'),
        taxRateBp: 0,
        itemId,
      },
    ],
  });
  if (created.status !== 201) throw new Error(`fixture: invoice create failed ${created.status} ${created.text}`);
  const invoiceId = created.body.invoice.id as string;
  const issued = await agentA.post(`/api/v1/invoices/${invoiceId}/issue`).send({});
  if (issued.status !== 200) throw new Error(`fixture: invoice issue failed ${issued.status} ${issued.text}`);

  await issueInvoice(agentA, orgA, beta, 10000, '2026-09-10', '2026-12-31');
  await issueInvoice(agentA, orgA, acme, 5000, '2026-08-10', '2026-12-31');
  await issueCreditNote(agentA, orgA, invoiceId, 3000, '2026-09-20');
});

afterAll(closePool);

describe('sales and purchases reports', () => {
  it('sales by customer', async () => {
    const r = await report(agentA, 'sales-by-customer');
    expect(r.rows.map((x) => [x.label, x.netCents])).toEqual([
      ['Acme', 27000],
      ['Beta', 10000],
    ]);
    const tax = await agentA.get(`${REPORTS}/tax-summary`).query({ from: FROM, to: TO });
    expect(tax.status).toBe(200);
    expect(r.totalNetCents).toBe((tax.body as { output: { netCents: number } }).output.netCents);
  });

  it('sales by item', async () => {
    const r = await report(agentA, 'sales-by-item');
    const wid = r.rows.find((x) => x.code === 'WID');
    expect(wid).toMatchObject({ label: 'Widget', quantityMilli: 3000, netCents: 30000 });
    const none = r.rows.find((x) => x.key === 'none');
    expect(none).toMatchObject({ label: 'No item', netCents: 7000 });
    expect(r.rows[r.rows.length - 1]?.key).toBe('none');
  });

  it('compare previous period', async () => {
    const r = await report(agentA, 'sales-by-customer', { compare: 'previousPeriod' });
    expect(r.rows.find((x) => x.label === 'Acme')?.comparisonNetCents).toBe(5000);
    expect(r.rows.find((x) => x.label === 'Beta')?.comparisonNetCents).toBe(0);
  });

  it('purchases by vendor', async () => {
    const vendor = await createVendor(agentA, 'Steel Supply');
    await postBill(agentA, orgA, vendor, { billDate: '2026-09-12', unitPriceCents: 8000 });
    const r = await report(agentA, 'purchases-by-vendor');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ label: 'Steel Supply', netCents: 8000 });
  });

  it('cross-tenant', async () => {
    for (const kind of ['sales-by-customer', 'sales-by-item']) {
      const r = await report(agentB, kind);
      expect(r.rows).toEqual([]);
    }
  });

  it('xlsx', async () => {
    const res = await agentA
      .get(`${REPORTS}/sales-by-item`)
      .query({ from: FROM, to: TO, format: 'xlsx' })
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(200);
    const sheet = readZip(res.body as Buffer).get('xl/worksheets/sheet1.xml');
    expect(sheet?.toString('utf8')).toContain('WID');
  });
});
