import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { getUsageSummary, listCallsForEntity, recordCall } from '../../services/aiUsageService.js';
import type { ModelCallRecord } from '../../types/aiUsage.js';

/**
 * aiUsageService and GET /api/v1/ai-usage. Platform-level metering
 * (Phase 19.1) — the mandatory cross-tenant suite is here, not deferred to
 * a later phase.
 */

const app = createApp();
const BASE = '/api/v1/ai-usage';

function callRecord(overrides: Partial<ModelCallRecord> = {}): ModelCallRecord {
  return {
    appSlug: 'ap-flow',
    purpose: 'EXTRACT',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    entityType: null,
    entityId: null,
    usage: { inputTokens: 1500, outputTokens: 300, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 1800 },
    status: 'OK',
    errorCode: null,
    latencyMs: 500,
    createdBy: null,
    ...overrides,
  };
}

describe('aiUsageService', () => {
  let userA: SeededUser;
  let orgA: string;
  let userB: SeededUser;
  let orgB: string;

  beforeEach(async () => {
    await resetTables();
    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;
    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
    orgB = userB.orgId;
  });

  afterAll(closePool);

  it('recordCall stores tokens and a computed cost for a priced model', async () => {
    await recordCall(orgA, callRecord());
    const { rows } = await pool.query<{ cost_micro_usd: string; pricing_version: string }>(
      'SELECT cost_micro_usd, pricing_version FROM ai_model_calls WHERE org_id = $1',
      [orgA],
    );
    // 1500 input @ $2/MTok = 3000, 300 output @ $10/MTok = 3000 -> 6000
    expect(rows[0]?.cost_micro_usd).toBe('6000');
    expect(rows[0]?.pricing_version).not.toBeNull();
  });

  it('recordCall leaves cost null for a model with no verified price', async () => {
    await recordCall(orgA, callRecord({ provider: 'gemini', model: 'gemini-3.6-flash' }));
    const { rows } = await pool.query<{ cost_micro_usd: string | null; pricing_version: string | null }>(
      'SELECT cost_micro_usd, pricing_version FROM ai_model_calls WHERE org_id = $1',
      [orgA],
    );
    expect(rows[0]?.cost_micro_usd).toBeNull();
    expect(rows[0]?.pricing_version).toBeNull();
  });

  it('recordCall stores a row with zero tokens when usage is null', async () => {
    await recordCall(orgA, callRecord({ usage: null }));
    const { rows } = await pool.query<{ input_tokens: string; output_tokens: string; cost_micro_usd: string | null }>(
      'SELECT input_tokens, output_tokens, cost_micro_usd FROM ai_model_calls WHERE org_id = $1',
      [orgA],
    );
    expect(rows[0]?.input_tokens).toBe('0');
    expect(rows[0]?.output_tokens).toBe('0');
    expect(rows[0]?.cost_micro_usd).toBeNull();
  });

  it('recordCall never throws on a database failure', async () => {
    await expect(
      recordCall(orgA, callRecord({ createdBy: '00000000-0000-0000-0000-000000000099' })),
    ).resolves.toBeUndefined();
    const { rows } = await pool.query('SELECT 1 FROM ai_model_calls WHERE org_id = $1', [orgA]);
    expect(rows).toHaveLength(0);
  });

  it('recordCall prices cached input at the input rate', async () => {
    await recordCall(
      orgA,
      callRecord({
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 1000, reasoningTokens: 0, totalTokens: 1000 },
      }),
    );
    const { rows } = await pool.query<{ cost_micro_usd: string }>(
      'SELECT cost_micro_usd FROM ai_model_calls WHERE org_id = $1',
      [orgA],
    );
    expect(rows[0]?.cost_micro_usd).toBe('2000');
  });

  it('getUsageSummary totals only priced rows and counts the rest', async () => {
    await recordCall(orgA, callRecord());
    await recordCall(orgA, callRecord({ provider: 'gemini', model: 'gemini-3.6-flash' }));

    const usage = await getUsageSummary(orgA, { from: null, to: null, appSlug: null });
    expect(usage.totals.callCount).toBe(2);
    expect(usage.totals.costMicroUsd).toBe(6000);
    expect(usage.totals.unpricedCallCount).toBe(1);
  });

  it('getUsageSummary groups by model, app, purpose and day', async () => {
    await recordCall(orgA, callRecord({ purpose: 'EXTRACT', model: 'claude-sonnet-5' }));
    await recordCall(orgA, callRecord({ purpose: 'CLASSIFY', provider: 'gemini', model: 'gemini-3.6-flash' }));

    const usage = await getUsageSummary(orgA, { from: null, to: null, appSlug: null });
    expect(usage.byModel).toHaveLength(2);
    expect(usage.byApp[0]?.key).toBe('ap-flow');
    expect(usage.byPurpose.map((p) => p.key).sort()).toEqual(['CLASSIFY', 'EXTRACT']);
    expect(usage.byDay).toHaveLength(1);
  });

  it('getUsageSummary honours an inclusive to-date', async () => {
    await recordCall(orgA, callRecord());
    const today = new Date().toISOString().slice(0, 10);

    const usage = await getUsageSummary(orgA, { from: null, to: today, appSlug: null });
    expect(usage.totals.callCount).toBe(1);
  });

  it('getUsageSummary filters by appSlug', async () => {
    await recordCall(orgA, callRecord({ appSlug: 'ap-flow' }));
    await recordCall(orgA, callRecord({ appSlug: 'taxguard' }));

    const usage = await getUsageSummary(orgA, { from: null, to: null, appSlug: 'ap-flow' });
    expect(usage.totals.callCount).toBe(1);
  });

  it('an ERROR call is counted but contributes no tokens', async () => {
    await recordCall(orgA, callRecord({ status: 'ERROR', errorCode: '502', usage: null }));

    const usage = await getUsageSummary(orgA, { from: null, to: null, appSlug: null });
    expect(usage.totals.errorCount).toBe(1);
    expect(usage.totals.totalTokens).toBe(0);
  });

  it('listCallsForEntity returns only that entity\'s calls', async () => {
    const doc1 = randomUUID();
    const doc2 = randomUUID();
    await recordCall(orgA, callRecord({ entityType: 'ap_flow_document', entityId: doc1 }));
    await recordCall(orgA, callRecord({ entityType: 'ap_flow_document', entityId: doc2 }));

    const doc1Calls = await listCallsForEntity(orgA, 'ap_flow_document', doc1);
    expect(doc1Calls).toHaveLength(1);
    const doc2Calls = await listCallsForEntity(orgA, 'ap_flow_document', doc2);
    expect(doc2Calls).toHaveLength(1);
  });

  it('GET /ai-usage is readable by a VIEWER', async () => {
    const viewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic Solo' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, userA);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const viewerAgent = await loginAgent(app, viewer);
    const res = await viewerAgent.get(BASE);
    expect(res.status).toBe(200);
  });

  it('GET /ai-usage requires authentication', async () => {
    const { default: supertest } = await import('supertest');
    const res = await supertest(app).get(BASE);
    expect(res.status).toBe(401);
  });

  it('GET /ai-usage rejects a malformed from date', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(BASE).query({ from: '15/08/2026' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('from must be a date in YYYY-MM-DD format');
  });

  it('cross-tenant: one organization never sees another\'s usage', async () => {
    await recordCall(orgA, callRecord());
    await recordCall(orgA, callRecord());

    const orgBSummary = await getUsageSummary(orgB, { from: null, to: null, appSlug: null });
    expect(orgBSummary.totals.callCount).toBe(0);
    expect(orgBSummary.byModel).toHaveLength(0);
  });

  it('cross-tenant: listCallsForEntity refuses another organization\'s entity', async () => {
    const doc1 = randomUUID();
    await recordCall(orgA, callRecord({ entityType: 'ap_flow_document', entityId: doc1 }));

    const fromOrgB = await listCallsForEntity(orgB, 'ap_flow_document', doc1);
    expect(fromOrgB).toHaveLength(0);
  });

  it('cross-tenant: a forged orgId in the query string, a header and the body is ignored', async () => {
    await recordCall(orgA, callRecord());
    const agentB = await loginAgent(app, userB);

    const honest = await agentB.get(BASE);
    const forged = await agentB.get(BASE).query({ orgId: orgA }).set('X-Org-Id', orgA).send({ orgId: orgA });

    expect(forged.status).toBe(200);
    expect(forged.body).toEqual(honest.body);
  });
});
