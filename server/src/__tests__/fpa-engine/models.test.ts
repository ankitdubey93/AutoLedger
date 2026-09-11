import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

const app = createApp();
const MODELS_BASE = '/api/v1/fpa-engine/models';
const SCENARIOS_BASE = '/api/v1/fpa-engine/scenarios';

async function switchTo(agent: Awaited<ReturnType<typeof loginAgent>>, targetOrgId: string) {
  const res = await agent.post('/api/v1/auth/switch-org').send({ orgId: targetOrgId });
  expect(res.status).toBe(200);
  return agent;
}

describe('fpa-engine models and scenarios API', () => {
  let userA: SeededUser;
  let userB: SeededUser;
  let orgA: string;
  let userAccountant: SeededUser;
  let userViewer: SeededUser;

  beforeEach(async () => {
    await resetTables();

    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;

    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });

    userAccountant = await createUserWithOrg({ label: 'ann', orgName: 'Org Ann Solo' });
    await addMember(orgA, userAccountant.id, 'ACCOUNTANT');

    userViewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic Solo' });
    await addMember(orgA, userViewer.id, 'VIEWER');
  });

  afterAll(closePool);

  async function createBasicModel(agent: Awaited<ReturnType<typeof loginAgent>>) {
    const res = await agent.post(MODELS_BASE).send({
      name: 'FY27 Plan',
      startsOn: '2026-10-01',
      horizonMonths: 12,
      actualsThrough: '2026-09-01',
    });
    return res;
  }

  it('1. creates a model with a default Base scenario', async () => {
    const agent = await loginAgent(app, userA);
    const res = await createBasicModel(agent);

    expect(res.status).toBe(201);
    expect(res.body.model.scenarios).toHaveLength(1);
    expect(res.body.model.scenarios[0].kind).toBe('BASE');
    expect(res.body.model.scenarios[0].isDefault).toBe(true);
  });

  it('2. rejects a duplicate model name with 409', async () => {
    const agent = await loginAgent(app, userA);
    await createBasicModel(agent);
    const res = await createBasicModel(agent);
    expect(res.status).toBe(409);
  });

  it('3. rejects actualsThrough equal to startsOn with 422', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(MODELS_BASE).send({
      name: 'Bad Model',
      startsOn: '2026-10-01',
      horizonMonths: 12,
      actualsThrough: '2026-10-01',
    });
    expect(res.status).toBe(422);
  });

  it('4. rejects a mid-month startsOn with 400', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(MODELS_BASE).send({
      name: 'Bad Model',
      startsOn: '2026-10-15',
      horizonMonths: 12,
      actualsThrough: '2026-09-01',
    });
    expect(res.status).toBe(400);
  });

  it('5. rejects horizonMonths above 60 with 400', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(MODELS_BASE).send({
      name: 'Bad Model',
      startsOn: '2026-10-01',
      horizonMonths: 61,
      actualsThrough: '2026-09-01',
    });
    expect(res.status).toBe(400);
  });

  it('6. refuses creation by a VIEWER with 403', async () => {
    const agent = await loginAgent(app, userViewer);
    await switchTo(agent, orgA);
    const res = await createBasicModel(agent);
    expect(res.status).toBe(403);
  });

  it('7. cross-tenant GET returns 404, not 403 or 200', async () => {
    const agentB = await loginAgent(app, userB);
    const created = await createBasicModel(agentB);
    const modelId = created.body.model.id;

    const agentA = await loginAgent(app, userA);
    const res = await agentA.get(`${MODELS_BASE}/${modelId}`);
    expect(res.status).toBe(404);
  });

  it('8. cross-tenant PATCH returns 404 and leaves the row unchanged', async () => {
    const agentB = await loginAgent(app, userB);
    const created = await createBasicModel(agentB);
    const modelId = created.body.model.id;

    const agentA = await loginAgent(app, userA);
    const res = await agentA.patch(`${MODELS_BASE}/${modelId}`).send({ name: 'Hijacked' });
    expect(res.status).toBe(404);

    const { rows } = await pool.query<{ name: string }>('SELECT name FROM fpa_models WHERE id = $1', [modelId]);
    expect(rows[0]?.name).toBe('FY27 Plan');
  });

  it('9. lists only the caller org\'s models', async () => {
    const agentA = await loginAgent(app, userA);
    await createBasicModel(agentA);

    const agentB = await loginAgent(app, userB);
    await createBasicModel(agentB);

    const res = await agentA.get(MODELS_BASE);
    expect(res.status).toBe(200);
    expect(res.body.models).toHaveLength(1);
    expect(res.body.models[0].id).toBeDefined();
  });

  it('10. ARCHIVED is not terminal — can move back to ACTIVE, but not to DRAFT', async () => {
    const agent = await loginAgent(app, userA);
    const created = await createBasicModel(agent);
    const modelId = created.body.model.id;

    const archived = await agent.patch(`${MODELS_BASE}/${modelId}`).send({ status: 'ARCHIVED' });
    expect(archived.status).toBe(200);

    const reactivated = await agent.patch(`${MODELS_BASE}/${modelId}`).send({ status: 'ACTIVE' });
    expect(reactivated.status).toBe(200);

    const archivedAgain = await agent.patch(`${MODELS_BASE}/${modelId}`).send({ status: 'ARCHIVED' });
    expect(archivedAgain.status).toBe(200);

    const illegal = await agent.patch(`${MODELS_BASE}/${modelId}`).send({ status: 'DRAFT' });
    expect(illegal.status).toBe(409);
  });

  it('11. creates a non-default scenario', async () => {
    const agent = await loginAgent(app, userA);
    const created = await createBasicModel(agent);
    const modelId = created.body.model.id;

    const res = await agent.post(`${MODELS_BASE}/${modelId}/scenarios`).send({
      name: 'Downside',
      kind: 'DOWNSIDE',
      dsoDays: 60,
      dpoDays: 30,
      taxRateBps: 2500,
    });
    expect(res.status).toBe(201);
    expect(res.body.scenario.isDefault).toBe(false);
  });

  it('12. promoting a scenario to default un-defaults the old one', async () => {
    const agent = await loginAgent(app, userA);
    const created = await createBasicModel(agent);
    const modelId = created.body.model.id;

    const newScenario = await agent.post(`${MODELS_BASE}/${modelId}/scenarios`).send({
      name: 'Upside',
      kind: 'UPSIDE',
      dsoDays: 30,
      dpoDays: 30,
      taxRateBps: 2500,
    });
    const newScenarioId = newScenario.body.scenario.id;

    const promoted = await agent.patch(`${SCENARIOS_BASE}/${newScenarioId}`).send({ isDefault: true });
    expect(promoted.status).toBe(200);

    const list = await agent.get(`${MODELS_BASE}/${modelId}/scenarios`);
    const defaults = list.body.scenarios.filter((s: { isDefault: boolean }) => s.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(newScenarioId);
  });

  it('13. refuses to delete the default scenario with 409', async () => {
    const agent = await loginAgent(app, userA);
    const created = await createBasicModel(agent);
    const defaultScenarioId = created.body.model.scenarios[0].id;

    const res = await agent.delete(`${SCENARIOS_BASE}/${defaultScenarioId}`);
    expect(res.status).toBe(409);
  });

  it('14. delete model: ACCOUNTANT forbidden, OWNER succeeds and cascades scenarios', async () => {
    const agentOwner = await loginAgent(app, userA);
    const created = await createBasicModel(agentOwner);
    const modelId = created.body.model.id;

    const agentAccountant = await loginAgent(app, userAccountant);
    await switchTo(agentAccountant, orgA);
    const forbidden = await agentAccountant.delete(`${MODELS_BASE}/${modelId}`);
    expect(forbidden.status).toBe(403);

    const res = await agentOwner.delete(`${MODELS_BASE}/${modelId}`);
    expect(res.status).toBe(200);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM fpa_scenarios WHERE model_id = $1',
      [modelId],
    );
    expect(rows[0]?.count).toBe('0');
  });
});
