import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

const app = createApp();
const MODELS_BASE = '/api/v1/fpa-engine/models';

async function switchTo(agent: Awaited<ReturnType<typeof loginAgent>>, targetOrgId: string) {
  const res = await agent.post('/api/v1/auth/switch-org').send({ orgId: targetOrgId });
  expect(res.status).toBe(200);
  return agent;
}

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code}`);
  return row.id;
}

describe('fpa-engine assumptions API', () => {
  let userA: SeededUser;
  let userB: SeededUser;
  let orgA: string;
  let orgB: string;
  let userViewer: SeededUser;
  let scenarioId: string;

  beforeEach(async () => {
    await resetTables();

    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;

    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
    orgB = userB.orgId;

    userViewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic Solo' });
    await addMember(orgA, userViewer.id, 'VIEWER');

    const agent = await loginAgent(app, userA);
    const created = await agent.post(MODELS_BASE).send({
      name: 'FY27 Plan',
      startsOn: '2026-10-01',
      horizonMonths: 12,
      actualsThrough: '2026-09-01',
    });
    scenarioId = created.body.model.scenarios[0].id;
  });

  afterAll(closePool);

  function assumptionsUrl(sid: string, code: string, orgId: string) {
    return accountId(orgId, code).then((id) => `/api/v1/fpa-engine/scenarios/${sid}/assumptions/${id}`);
  }

  it('1. sets a GROWTH_BPS assumption on a revenue account', async () => {
    const agent = await loginAgent(app, userA);
    const url = await assumptionsUrl(scenarioId, '4100', orgA);

    const res = await agent.put(url).send({ kind: 'GROWTH_BPS', growthBps: 500 });
    expect(res.status).toBe(200);
    expect(res.body.assumption.growthBps).toBe(500);
    expect(res.body.assumption.fixedCents).toBeNull();
    expect(res.body.assumption.percentOfRevenueBps).toBeNull();
  });

  it('2. re-upserting with a different kind clears the other columns', async () => {
    const agent = await loginAgent(app, userA);
    const url = await assumptionsUrl(scenarioId, '4100', orgA);

    await agent.put(url).send({ kind: 'GROWTH_BPS', growthBps: 500 });
    const second = await agent.put(url).send({ kind: 'FIXED_CENTS', fixedCents: 250000 });
    expect(second.status).toBe(200);

    const list = await agent.get(`/api/v1/fpa-engine/scenarios/${scenarioId}/assumptions`);
    expect(list.body.assumptions).toHaveLength(1);
    expect(list.body.assumptions[0].growthBps).toBeNull();
    expect(list.body.assumptions[0].fixedCents).toBe(250000);
  });

  it('3. rejects a mismatched kind/payload with 400', async () => {
    const agent = await loginAgent(app, userA);
    const url = await assumptionsUrl(scenarioId, '4100', orgA);

    const res = await agent.put(url).send({ kind: 'GROWTH_BPS', fixedCents: 100 });
    expect(res.status).toBe(400);
  });

  it('4. rejects an assumption on a header account with 422', async () => {
    const agent = await loginAgent(app, userA);
    const url = await assumptionsUrl(scenarioId, '1000', orgA);

    const res = await agent.put(url).send({ kind: 'FIXED_CENTS', fixedCents: 1000 });
    expect(res.status).toBe(422);
  });

  it('5. rejects an assumption on an Asset account with 422', async () => {
    const agent = await loginAgent(app, userA);
    const url = await assumptionsUrl(scenarioId, '1110', orgA);

    const res = await agent.put(url).send({ kind: 'FIXED_CENTS', fixedCents: 1000 });
    expect(res.status).toBe(422);
  });

  it('6. rejects PERCENT_OF_REVENUE_BPS on a revenue account with 422', async () => {
    const agent = await loginAgent(app, userA);
    const url = await assumptionsUrl(scenarioId, '4100', orgA);

    const res = await agent.put(url).send({ kind: 'PERCENT_OF_REVENUE_BPS', percentOfRevenueBps: 3000 });
    expect(res.status).toBe(422);
  });

  it('7. allows PERCENT_OF_REVENUE_BPS on an expense account', async () => {
    const agent = await loginAgent(app, userA);
    const url = await assumptionsUrl(scenarioId, '6100', orgA);

    const res = await agent.put(url).send({ kind: 'PERCENT_OF_REVENUE_BPS', percentOfRevenueBps: 3000 });
    expect(res.status).toBe(200);
  });

  it('8. cross-tenant PUT with another org\'s account returns 404 and writes nothing', async () => {
    const agent = await loginAgent(app, userA);
    const foreignAccountId = await accountId(orgB, '4100');

    const res = await agent
      .put(`/api/v1/fpa-engine/scenarios/${scenarioId}/assumptions/${foreignAccountId}`)
      .send({ kind: 'FIXED_CENTS', fixedCents: 1000 });
    expect(res.status).toBe(404);

    const { rows } = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM fpa_assumptions');
    expect(rows[0]?.count).toBe('0');
  });

  it('9. cross-tenant GET on another org\'s scenario returns 404', async () => {
    const agentB = await loginAgent(app, userB);
    const createdB = await agentB.post(MODELS_BASE).send({
      name: 'Other Plan',
      startsOn: '2026-10-01',
      horizonMonths: 12,
      actualsThrough: '2026-09-01',
    });
    const scenarioIdB = createdB.body.model.scenarios[0].id;

    const agentA = await loginAgent(app, userA);
    const res = await agentA.get(`/api/v1/fpa-engine/scenarios/${scenarioIdB}/assumptions`);
    expect(res.status).toBe(404);
  });

  it('10. refuses PUT by a VIEWER with 403', async () => {
    const agent = await loginAgent(app, userViewer);
    await switchTo(agent, orgA);
    const url = await assumptionsUrl(scenarioId, '4100', orgA);

    const res = await agent.put(url).send({ kind: 'GROWTH_BPS', growthBps: 500 });
    expect(res.status).toBe(403);
  });

  it('11. delete then delete again returns 200 then 404', async () => {
    const agent = await loginAgent(app, userA);
    const url = await assumptionsUrl(scenarioId, '4100', orgA);
    await agent.put(url).send({ kind: 'GROWTH_BPS', growthBps: 500 });

    const first = await agent.delete(url);
    expect(first.status).toBe(200);

    const second = await agent.delete(url);
    expect(second.status).toBe(404);
  });

  it('12. raw SQL: a kind/payload mismatch is rejected with 23514', async () => {
    const acctId = await accountId(orgA, '4100');
    let code: string | undefined;
    try {
      await pool.query(
        `INSERT INTO fpa_assumptions (org_id, scenario_id, account_id, kind, growth_bps, fixed_cents)
         VALUES ($1, $2, $3, 'GROWTH_BPS', 500, 999)`,
        [orgA, scenarioId, acctId],
      );
    } catch (err) {
      if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') {
        code = err.code;
      }
    }
    expect(code).toBe('23514');
  });
});
