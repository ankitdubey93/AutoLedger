import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Platform onboarding state — Phase 9a. Integration tier, real PostgreSQL.
 *
 * Includes this module's mandatory cross-tenant isolation case (rule 15).
 */

const app = createApp();
const BASE = '/api/v1/onboarding';

let userA: SeededUser;
let userB: SeededUser;
let userC: SeededUser;
let userAccountant: SeededUser;
let orgA: string;
let orgB: string;

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userC = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userC.orgId;

  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bobs Own' });
  await addMember(orgA, userB.id, 'ADMIN');
  await addMember(orgB, userB.id, 'ADMIN');

  userAccountant = await createUserWithOrg({ label: 'ann', orgName: 'Org Ann Solo' });
  await addMember(orgA, userAccountant.id, 'ACCOUNTANT');
});

afterAll(closePool);

it('GET /onboarding returns one item per app plus platform, all NOT_STARTED for a fresh org', async () => {
  const agent = await loginAgent(app, userA);
  const res = await agent.get(BASE);

  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(8);
  for (const item of res.body.items as { status: string; draft: Record<string, unknown> }[]) {
    expect(item.status).toBe('NOT_STARTED');
    expect(item.draft).toEqual({});
  }
});

it('PUT /onboarding/ledger-core/draft stores the step and draft and moves the row to IN_PROGRESS', async () => {
  const agent = await loginAgent(app, userA);
  const res = await agent
    .put(`${BASE}/ledger-core/draft`)
    .send({ currentStep: 'currency', draft: { baseCurrency: 'INR' } });

  expect(res.status).toBe(200);
  expect(res.body.onboarding.status).toBe('IN_PROGRESS');
  expect(res.body.onboarding.currentStep).toBe('currency');
  expect(res.body.onboarding.draft.baseCurrency).toBe('INR');
});

it('a second PUT to the same slug updates in place rather than 409-ing', async () => {
  const agent = await loginAgent(app, userA);
  const first = await agent
    .put(`${BASE}/ledger-core/draft`)
    .send({ currentStep: 'currency', draft: { baseCurrency: 'INR' } });
  expect(first.status).toBe(200);

  const second = await agent
    .put(`${BASE}/ledger-core/draft`)
    .send({ currentStep: 'fiscal-year', draft: { baseCurrency: 'INR', fiscalYearStartMonth: 4 } });
  expect(second.status).toBe(200);

  const { rows } = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM onboarding_states WHERE org_id = $1 AND app_slug = 'ledger-core'",
    [orgA],
  );
  expect(rows[0]?.count).toBe('1');
});

it('POST /onboarding/ledger-core/skip sets SKIPPED and preserves the draft', async () => {
  const agent = await loginAgent(app, userA);
  await agent.put(`${BASE}/ledger-core/draft`).send({ currentStep: 'currency', draft: { baseCurrency: 'INR' } });

  const res = await agent.post(`${BASE}/ledger-core/skip`);
  expect(res.status).toBe(200);
  expect(res.body.onboarding.status).toBe('SKIPPED');
  expect(res.body.onboarding.skippedAt).not.toBeNull();
  expect(res.body.onboarding.draft.baseCurrency).toBe('INR');
});

it('POST /onboarding/ledger-core/resume returns a SKIPPED row to IN_PROGRESS and clears skippedAt', async () => {
  const agent = await loginAgent(app, userA);
  await agent.post(`${BASE}/ledger-core/skip`);

  const res = await agent.post(`${BASE}/ledger-core/resume`);
  expect(res.status).toBe(200);
  expect(res.body.onboarding.status).toBe('IN_PROGRESS');
  expect(res.body.onboarding.skippedAt).toBeNull();
});

it('completing LedgerCore onboarding marks its row COMPLETED in the same transaction', async () => {
  const agent = await loginAgent(app, userA);
  const onboardRes = await agent.post('/api/v1/ledger-core/settings/onboarding').send({
    organizationName: 'Acme Books',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    booksStartDate: '2026-01-01',
  });
  expect(onboardRes.status).toBe(200);

  const res = await agent.get(`${BASE}/ledger-core`);
  expect(res.status).toBe(200);
  expect(res.body.onboarding.status).toBe('COMPLETED');
  expect(res.body.onboarding.completedAt).not.toBeNull();
});

it('COMPLETED is not terminal — resume moves it back to IN_PROGRESS', async () => {
  const agent = await loginAgent(app, userA);
  await agent.post('/api/v1/ledger-core/settings/onboarding').send({
    organizationName: 'Acme Books',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    booksStartDate: '2026-01-01',
  });

  const res = await agent.post(`${BASE}/ledger-core/resume`);
  expect(res.status).toBe(200);
  expect(res.body.onboarding.status).toBe('IN_PROGRESS');
});

it('an unknown app slug is a 404', async () => {
  const agent = await loginAgent(app, userA);
  const res = await agent.get(`${BASE}/not-an-app`);
  expect(res.status).toBe(404);
});

it('an ACCOUNTANT may read the checklist but not skip', async () => {
  const agent = await loginAgent(app, userAccountant);
  await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

  const readRes = await agent.get(BASE);
  expect(readRes.status).toBe(200);

  const skipRes = await agent.post(`${BASE}/ledger-core/skip`);
  expect(skipRes.status).toBe(403);
});

describe('cross-tenant isolation', () => {
  it("org A's token never sees or mutates org B's onboarding state", async () => {
    const agentC = await loginAgent(app, userC);
    await agentC.post(`${BASE}/ledger-core/skip`);

    const agentA = await loginAgent(app, userA);
    const readAsA = await agentA.get(`${BASE}/ledger-core`);
    expect(readAsA.body.onboarding.status).toBe('NOT_STARTED');

    await agentA.put(`${BASE}/ledger-core/draft`).send({ currentStep: 'x', draft: { a: 1 } });

    const readAsC = await agentC.get(`${BASE}/ledger-core`);
    expect(readAsC.body.onboarding.status).toBe('SKIPPED');
  });
});

it('a draft containing SQL-shaped keys is stored and returned verbatim', async () => {
  const agent = await loginAgent(app, userA);
  const maliciousKey = "'; DROP TABLE onboarding_states; --";
  const res = await agent.put(`${BASE}/ledger-core/draft`).send({
    currentStep: null,
    draft: { [maliciousKey]: 1 },
  });

  expect(res.status).toBe(200);
  expect(res.body.onboarding.draft[maliciousKey]).toBe(1);

  const { rows } = await pool.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'onboarding_states') AS exists",
  );
  expect(rows[0]?.exists).toBe(true);
});
