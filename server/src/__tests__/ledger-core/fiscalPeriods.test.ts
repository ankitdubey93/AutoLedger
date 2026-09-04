import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — fiscal periods (Phase 4). Integration tier, real PostgreSQL.
 *
 * Includes this module's own cross-tenant isolation suite (rule 15).
 */

const app = createApp();
const PERIODS = '/api/v1/ledger-core/fiscal-periods';
const ONBOARDING = '/api/v1/ledger-core/settings/onboarding';

let userA: SeededUser;
let userC: SeededUser;
let orgA: string;

type Agent = Awaited<ReturnType<typeof loginAgent>>;

async function onboard(agent: Agent, overrides: Record<string, unknown> = {}) {
  const res = await agent.post(ONBOARDING).send({
    organizationName: 'Acme Books',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    booksStartDate: '2026-01-01',
    ...overrides,
  });
  if (res.status !== 200) throw new Error(`fixture: onboarding failed ${res.status} ${res.text}`);
  return res;
}

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  orgA = userA.orgId;

  userC = await createUserWithOrg({ label: 'carol', orgName: 'Org Charlie' });
});

afterAll(async () => {
  await closePool();
});

describe('POST /fiscal-periods/generate', () => {
  it('generates 12 monthly periods for a Jan-1 fiscal year', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);

    const res = await agent.post(`${PERIODS}/generate`).send({ containingDate: '2026-06-15' });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.count).toBe(12);
    expect(res.body.periods[0]).toMatchObject({ startsOn: '2026-01-01', status: 'OPEN' });
    expect(res.body.periods[11]).toMatchObject({ endsOn: '2026-12-31' });
  });

  it('is idempotent — a second call for the same fiscal year creates nothing', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);
    await agent.post(`${PERIODS}/generate`).send({ containingDate: '2026-06-15' });

    const res = await agent.post(`${PERIODS}/generate`).send({ containingDate: '2026-06-15' });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    expect(res.body.count).toBe(12);

    const list = await agent.get(PERIODS);
    expect(list.body.count).toBe(12);
  });

  it('refuses to generate before onboarding has completed once', async () => {
    const agent = await loginAgent(app, userA);

    const res = await agent.post(`${PERIODS}/generate`).send({ containingDate: '2026-06-15' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Complete LedgerCore onboarding before generating fiscal periods');
  });
});

describe('period transitions', () => {
  async function generateAndGetJanuary(agent: Agent): Promise<string> {
    await onboard(agent);
    const res = await agent.post(`${PERIODS}/generate`).send({ containingDate: '2026-06-15' });
    return res.body.periods[0].id as string;
  }

  it('closes an OPEN period', async () => {
    const agent = await loginAgent(app, userA);
    const januaryId = await generateAndGetJanuary(agent);

    const res = await agent.post(`${PERIODS}/${januaryId}/close`);

    expect(res.status).toBe(200);
    expect(res.body.period.status).toBe('CLOSED');
    expect(res.body.period.closedAt).not.toBeNull();
    expect(res.body.period.closedByName).toBe('alice');
  });

  it('refuses to close an already-closed period', async () => {
    const agent = await loginAgent(app, userA);
    const januaryId = await generateAndGetJanuary(agent);
    await agent.post(`${PERIODS}/${januaryId}/close`);

    const res = await agent.post(`${PERIODS}/${januaryId}/close`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Cannot close a closed period');
  });

  it('reopens a CLOSED period, clearing the close stamp', async () => {
    const agent = await loginAgent(app, userA);
    const januaryId = await generateAndGetJanuary(agent);
    await agent.post(`${PERIODS}/${januaryId}/close`);

    const res = await agent.post(`${PERIODS}/${januaryId}/reopen`);

    expect(res.status).toBe(200);
    expect(res.body.period.status).toBe('OPEN');
    expect(res.body.period.closedAt).toBeNull();
    expect(res.body.period.closedBy).toBeNull();
  });

  it('locks a CLOSED period as OWNER', async () => {
    const agent = await loginAgent(app, userA);
    const januaryId = await generateAndGetJanuary(agent);
    await agent.post(`${PERIODS}/${januaryId}/close`);

    const res = await agent.post(`${PERIODS}/${januaryId}/lock`);

    expect(res.status).toBe(200);
    expect(res.body.period.status).toBe('LOCKED');
    expect(res.body.period.lockedAt).not.toBeNull();
  });

  it('refuses to lock an OPEN period', async () => {
    const agent = await loginAgent(app, userA);
    const januaryId = await generateAndGetJanuary(agent);

    const res = await agent.post(`${PERIODS}/${januaryId}/lock`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Cannot lock a open period');
  });

  it('refuses to reopen a LOCKED period — the lock is terminal', async () => {
    const agent = await loginAgent(app, userA);
    const januaryId = await generateAndGetJanuary(agent);
    await agent.post(`${PERIODS}/${januaryId}/close`);
    await agent.post(`${PERIODS}/${januaryId}/lock`);

    const res = await agent.post(`${PERIODS}/${januaryId}/reopen`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Cannot reopen a locked period');
  });
});

describe('role gates', () => {
  async function generateAndGetJanuary(agent: Agent): Promise<string> {
    await onboard(agent);
    const res = await agent.post(`${PERIODS}/generate`).send({ containingDate: '2026-06-15' });
    return res.body.periods[0].id as string;
  }

  it('refuses lock to an ADMIN', async () => {
    const ownerAgent = await loginAgent(app, userA);
    const januaryId = await generateAndGetJanuary(ownerAgent);
    await ownerAgent.post(`${PERIODS}/${januaryId}/close`);

    const admin = await createUserWithOrg({ label: 'admin-user' });
    await addMember(orgA, admin.id, 'ADMIN');
    const adminAgent = await loginAgent(app, admin);
    await adminAgent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const res = await adminAgent.post(`${PERIODS}/${januaryId}/lock`);
    expect(res.status).toBe(403);
  });

  it('refuses lock and close to an ACCOUNTANT', async () => {
    const ownerAgent = await loginAgent(app, userA);
    const januaryId = await generateAndGetJanuary(ownerAgent);

    const accountant = await createUserWithOrg({ label: 'accountant-user' });
    await addMember(orgA, accountant.id, 'ACCOUNTANT');
    const accountantAgent = await loginAgent(app, accountant);
    await accountantAgent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const closeRes = await accountantAgent.post(`${PERIODS}/${januaryId}/close`);
    expect(closeRes.status).toBe(403);

    await ownerAgent.post(`${PERIODS}/${januaryId}/close`);
    const lockRes = await accountantAgent.post(`${PERIODS}/${januaryId}/lock`);
    expect(lockRes.status).toBe(403);
  });

  it('allows a VIEWER to read periods', async () => {
    const ownerAgent = await loginAgent(app, userA);
    await generateAndGetJanuary(ownerAgent);

    const viewer = await createUserWithOrg({ label: 'viewer-user' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const viewerAgent = await loginAgent(app, viewer);
    await viewerAgent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const res = await viewerAgent.get(PERIODS);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(12);
  });
});

describe('GET /fiscal-periods filters', () => {
  it('filters by status', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);
    const generated = await agent.post(`${PERIODS}/generate`).send({ containingDate: '2026-06-15' });
    const januaryId = generated.body.periods[0].id as string;
    await agent.post(`${PERIODS}/${januaryId}/close`);

    const res = await agent.get(`${PERIODS}?status=CLOSED`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.periods[0].id).toBe(januaryId);
  });

  it('rejects an unrecognised status value', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);

    const res = await agent.get(`${PERIODS}?status=NONSENSE`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('status must be one of OPEN, CLOSED, LOCKED');
  });
});

describe('cross-tenant isolation', () => {
  it('a period id from org A returns 404 under org B and never appears in org B\'s list', async () => {
    const agentA = await loginAgent(app, userA);
    await onboard(agentA);
    const generated = await agentA.post(`${PERIODS}/generate`).send({ containingDate: '2026-06-15' });
    const januaryId = generated.body.periods[0].id as string;

    const agentB = await loginAgent(app, userC);

    const getRes = await agentB.get(`${PERIODS}/${januaryId}`);
    expect(getRes.status).toBe(404);

    const listRes = await agentB.get(PERIODS);
    expect(listRes.status).toBe(200);
    expect(listRes.body.count).toBe(0);

    const closeRes = await agentB.post(`${PERIODS}/${januaryId}/close`);
    expect(closeRes.status).toBe(404);
  });
});
