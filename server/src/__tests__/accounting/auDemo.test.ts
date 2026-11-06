import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import { closePool, pool } from '../../db/connect.js';
import { AU_ANSWER_KEY, defaultAuAnchor, runAuScenario, type AuApi } from '../../scripts/auDemoScenario.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';

/**
 * The Australian demo against its hand-worked answer key (Phase 49i). Runs on
 * both bases through the real API. The key is in auDemoScenario.ts and is worked
 * in walkthrough/australia/README.md.
 */

const app = createApp();
const ANCHOR = '2026-04-01'; // April to June, then July to September 2026.
const originalKey = env.INTEGRATION_ENCRYPTION_KEY;

type Agent = ReturnType<typeof request.agent>;

function apiOf(agent: Agent): AuApi {
  const wrap = (r: request.Test) => r.then((res) => ({ status: res.status, body: res.body as unknown, text: res.text }));
  return {
    get: (path) => wrap(agent.get(path)),
    post: (path, body) => wrap(agent.post(path).send((body ?? {}) as object)),
    patch: (path, body) => wrap(agent.patch(path).send((body ?? {}) as object)),
    put: (path, body) => wrap(agent.put(path).send((body ?? {}) as object)),
  };
}

async function balance(orgId: string, code: string): Promise<number> {
  const { rows } = await pool.query<{ d: string; c: string }>(
    `SELECT COALESCE(SUM(l.base_debit_cents),0)::text AS d, COALESCE(SUM(l.base_credit_cents),0)::text AS c
       FROM ledger_lines l JOIN accounts a ON a.id = l.account_id WHERE l.org_id = $1 AND a.code = $2`,
    [orgId, code],
  );
  return Number(rows[0]?.d ?? 0) - Number(rows[0]?.c ?? 0);
}

async function scenario(basis: 'CASH' | 'ACCRUAL') {
  const user = await createUserWithOrg({ label: 'au' });
  const agent = (await loginAgent(app, user)) as unknown as Agent;
  const result = await runAuScenario(apiOf(agent), ANCHOR, basis);
  const q1 = (await agent.get(`/api/v1/bas/${result.q1Id}`)).body.bas;
  const q2 = (await agent.get(`/api/v1/bas/${result.q2Id}`)).body.bas;
  return { user, agent, q1, q2, result };
}

beforeEach(async () => {
  await resetTables();
  Object.assign(env, { INTEGRATION_ENCRYPTION_KEY: 'a'.repeat(64) });
});

afterAll(async () => {
  Object.assign(env, { INTEGRATION_ENCRYPTION_KEY: originalKey });
  await closePool();
});

describe.each(['ACCRUAL', 'CASH'] as const)('%s basis', (basis) => {
  it('matches the hand-worked answer key, label by label, and reconciles to the ledger', async () => {
    const { q1, q2, user, agent, result } = await scenario(basis);
    const key = AU_ANSWER_KEY[basis];

    expect(q1.labels).toMatchObject(key.q1);
    expect(q1.summary.netPayable).toBe(key.netPayable.q1);
    expect(q1.status).toBe('LODGED');

    expect(q2.labels).toMatchObject(key.q2);
    expect(q2.summary.netPayable).toBe(key.netPayable.q2);
    expect(q2.reconciliation.sales.differenceCents).toBe(0);
    expect(q2.reconciliation.purchases.differenceCents).toBe(0);
    expect(q2.warnings.filter((w: { code: string }) => w.code !== 'PERIOD_NOT_ENDED')).toEqual([]);

    // Lodge the second quarter: with everything paid, the GST accounts clear to nothing.
    expect((await agent.post(`/api/v1/bas/${result.q2Id}/finalise`).send({})).status).toBe(200);
    expect((await agent.post(`/api/v1/bas/${result.q2Id}/lodge`).send({ lodgedOn: '2026-10-20' })).status).toBe(200);
    expect(await balance(user.orgId, '2140')).toBe(0);
    expect(await balance(user.orgId, '1180')).toBe(0);
    expect(await balance(user.orgId, '2162')).toBe(0);
    expect(await balance(user.orgId, '1185')).toBe(20_000);
    expect(await balance(user.orgId, '2150')).toBe(-(key.netPayable.q1 + key.netPayable.q2) * 100);
  });
});

describe('across both bases', () => {
  it('reports the same GST over the two quarters once everything is paid', () => {
    const total = (b: 'CASH' | 'ACCRUAL', label: '1A' | '1B') => AU_ANSWER_KEY[b].q1[label] + AU_ANSWER_KEY[b].q2[label];
    expect(total('CASH', '1A')).toBe(total('ACCRUAL', '1A'));
    expect(total('CASH', '1B')).toBe(total('ACCRUAL', '1B'));
    expect(total('CASH', '1A')).toBe(48_500);
    expect(total('CASH', '1B')).toBe(59_300);
  });
});

describe('the rest of the demo', () => {
  it('produces the TPAR, an ABA file and a tax invoice', async () => {
    const { agent, user } = await scenario('CASH');
    const first = (await agent.get('/api/v1/tpar/2026')).body.report;
    const second = (await agent.get('/api/v1/tpar/2027')).body.report;
    expect(first.totalGrossCents).toBe(AU_ANSWER_KEY.tpar.firstYear.grossPaidCents);
    expect(first.totalGstCents).toBe(AU_ANSWER_KEY.tpar.firstYear.gstCents);
    expect(second.totalGrossCents).toBe(AU_ANSWER_KEY.tpar.secondYear.grossPaidCents);
    expect(second.rows[0].name).toBe('Sunrise Cleaning');

    const batches = (await agent.get('/api/v1/pay-runs')).body.batches as { id: string; totalCents: number; paymentCount: number }[];
    expect(batches[0]).toMatchObject({ totalCents: 92_000, paymentCount: 2 });
    const file = await agent.get(`/api/v1/pay-runs/${batches[0]?.id ?? ''}/aba`);
    expect(file.text.split('\r\n').filter((l) => l !== '')).toHaveLength(4);

    const { rows } = await pool.query<{ seller_abn: string; seller_gst_registered: boolean }>(
      `SELECT seller_abn, seller_gst_registered FROM invoices WHERE org_id = $1 LIMIT 1`,
      [user.orgId],
    );
    expect(rows[0]).toEqual({ seller_abn: '90 123 400 160', seller_gst_registered: true });
  });
});

describe('the demo dates', () => {
  it.each([
    ['2026-11-06', '2026-04-01'],
    ['2026-07-01', '2026-01-01'],
    ['2026-02-10', '2025-07-01'],
  ])('on %s starts from the last two complete quarters', (today, anchor) => {
    expect(defaultAuAnchor(today)).toBe(anchor);
  });
});
