import type { Response } from 'superagent';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import { closePool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import { createCustomer, issueInvoice } from '../helpers/accountingFixtures.js';
import type { Agent } from '../helpers/accountingFixtures.js';
import { readZip } from '../helpers/zipReader.js';

/**
 * Phase 45 — report exports (?format=csv|xlsx|pdf). Integration tier, real
 * PostgreSQL. Org Alpha holds one 100.00 invoice; Org Bravo holds nothing and
 * must never see it in a file.
 */

const app = createApp();
const REPORTS = '/api/v1/reports';

function binary(res: Response, cb: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

let agentA: Agent;
let agentB: Agent;

afterAll(closePool);

describe('report exports', () => {
  beforeEach(async () => {
    await resetTables();
    const userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    const userB = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
    agentA = await loginAgent(app, userA);
    agentB = await loginAgent(app, userB);
    const customerId = await createCustomer(agentA, 'Northwind Traders');
    await issueInvoice(agentA, userA.orgId, customerId, 10000, '2026-09-10', '2026-10-10');
  });

  it('trial balance xlsx', async () => {
    const res = await agentA.get(`${REPORTS}/trial-balance?format=xlsx`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(
      /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/,
    );
    expect(res.headers['content-disposition']).toBe('attachment; filename="trial-balance-today.xlsx"');
    const sheet = readZip(res.body as Buffer).get('xl/worksheets/sheet1.xml');
    expect(sheet?.toString('utf8')).toContain('<v>100.00</v>');
  });

  it('p&l csv', async () => {
    const res = await agentA.get(`${REPORTS}/profit-and-loss?from=2026-09-01&to=2026-09-30&format=csv`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Total revenue,100.00');
  });

  it('balance sheet pdf', async () => {
    const res = await agentA.get(`${REPORTS}/balance-sheet?asOf=2026-09-30&format=pdf`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('bad format', async () => {
    const res = await agentA.get(`${REPORTS}/trial-balance?format=docx`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('format must be one of csv, xlsx, pdf');
  });

  it('json unchanged', async () => {
    const res = await agentA.get(`${REPORTS}/trial-balance`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.rows)).toBe(true);
  });

  it('ap aging pdf', async () => {
    const res = await agentA.get(`${REPORTS}/ap-aging?asOf=2026-09-30&format=pdf`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('cross-tenant', async () => {
    const res = await agentB.get(`${REPORTS}/trial-balance?format=csv`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('100.00');
  });

  it('cors exposes content-disposition', async () => {
    const res = await agentA
      .get(`${REPORTS}/trial-balance?format=csv`)
      .set('Origin', new URL(env.FRONTEND_URL).origin);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-expose-headers']).toContain('Content-Disposition');
  });
});

describe('ar aging export', () => {
  beforeEach(async () => {
    await resetTables();
    const userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    agentA = await loginAgent(app, userA);
    const customerId = await createCustomer(agentA, 'Northwind Traders');
    await issueInvoice(agentA, userA.orgId, customerId, 10000, '2026-09-10', '2026-09-20');
  });

  it('ar aging csv', async () => {
    const res = await agentA.get(`${REPORTS}/ar-aging?asOf=2026-09-30&format=csv`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Total,0.00,100.00');
  });
});
