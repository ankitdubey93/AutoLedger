import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { handleBoardDeckGenerate } from '../../queue/handlers/boarddeckGenerateHandler.js';
import * as deckBuilderService from '../../services/boarddeck/deckBuilderService.js';
import { getDeckById } from '../../services/boarddeck/deckService.js';
import { addMember, clearStorage, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * BoardDeck decks API + generate handler (Phase 15). Integration tier, real
 * PostgreSQL and Redis. The generate handler is called directly, never
 * through BullMQ — the same posture ap-flow/pipeline.test.ts established.
 * Includes this module's own cross-tenant isolation suite (rule 15).
 */

const app = createApp();
const DECKS = '/api/v1/boarddeck/decks';
const PERIODS = '/api/v1/ledger-core/fiscal-periods';
const ONBOARDING = '/api/v1/ledger-core/settings/onboarding';
const PLANS_BASE = '/api/v1/forecaster/plans';
const VERSIONS_BASE = '/api/v1/forecaster/budget-versions';

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;

type Agent = Awaited<ReturnType<typeof loginAgent>>;

async function switchTo(agent: Agent, targetOrgId: string) {
  const res = await agent.post('/api/v1/auth/switch-org').send({ orgId: targetOrgId });
  expect(res.status).toBe(200);
  return agent;
}

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id = $1 AND code = $2', [
    orgId,
    code,
  ]);
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code}`);
  return row.id;
}

async function onboardAndGenerateJune(agent: Agent): Promise<string> {
  const onboardRes = await agent.post(ONBOARDING).send({
    organizationName: 'Acme Books',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    booksStartDate: '2026-01-01',
  });
  if (onboardRes.status !== 200) throw new Error(`fixture: onboarding failed ${onboardRes.status}`);

  const genRes = await agent.post(`${PERIODS}/generate`).send({ containingDate: '2026-06-15' });
  if (genRes.status !== 201) throw new Error(`fixture: generate periods failed ${genRes.status}`);
  return genRes.body.periods[5].id as string; // June
}

async function createApprovedPlan(agent: Agent): Promise<string> {
  const planRes = await agent.post(PLANS_BASE).send({
    name: 'FY27 Plan',
    startsOn: '2026-06-01',
    horizonMonths: 3,
    actualsThrough: '2026-05-01',
  });
  const planId = planRes.body.plan.id as string;
  const expenseAccountId = await accountId(orgA, '6100');

  const versionRes = await agent.post(`${PLANS_BASE}/${planId}/budget-versions`).send({ label: 'Q1 Budget' });
  const versionId = versionRes.body.version.id as string;
  await agent.post(`${VERSIONS_BASE}/${versionId}/lines`).send({
    accountId: expenseAccountId,
    month: '2026-06-01',
    amountCents: 100_000,
    justification: 'Planned spend',
  });
  const approveRes = await agent.post(`${VERSIONS_BASE}/${versionId}/approve`);
  if (approveRes.status !== 200) throw new Error(`fixture: approve failed ${approveRes.status}`);
  return planId;
}

async function createPlanWithNoApprovedVersion(agent: Agent): Promise<string> {
  const planRes = await agent.post(PLANS_BASE).send({
    name: 'Unapproved Plan',
    startsOn: '2026-06-01',
    horizonMonths: 3,
    actualsThrough: '2026-05-01',
  });
  return planRes.body.plan.id as string;
}

beforeEach(async () => {
  await resetTables();
  await clearStorage();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userB.orgId;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(closePool);

describe('BoardDeck decks API', () => {
  it('POST /decks returns 202 with status PENDING', async () => {
    const agent = await loginAgent(app, userA);
    const juneId = await onboardAndGenerateJune(agent);

    const res = await agent.post(DECKS).send({ title: 'June Board Deck', fiscalPeriodId: juneId, planId: null });

    expect(res.status).toBe(202);
    expect(res.body.deck.status).toBe('PENDING');
  });

  it('the generate handler produces a READY deck with a non-zero byte size and 6 slides with a plan', async () => {
    const agent = await loginAgent(app, userA);
    const juneId = await onboardAndGenerateJune(agent);
    const planId = await createApprovedPlan(agent);

    const created = await agent.post(DECKS).send({ title: 'June Board Deck', fiscalPeriodId: juneId, planId });
    const deckId = created.body.deck.id as string;

    await handleBoardDeckGenerate({ orgId: orgA, deckId });

    const deck = await getDeckById(orgA, deckId);
    expect(deck.status).toBe('READY');
    expect(deck.byteSizeBytes).toBeGreaterThan(0);
    expect(deck.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(deck.slideCount).toBe(6);
  });

  it('a deck created without a planId has 4 slides (title, P&L, balance sheet, close checklist)', async () => {
    const agent = await loginAgent(app, userA);
    const juneId = await onboardAndGenerateJune(agent);

    const created = await agent.post(DECKS).send({ title: 'No Plan Deck', fiscalPeriodId: juneId, planId: null });
    const deckId = created.body.deck.id as string;

    await handleBoardDeckGenerate({ orgId: orgA, deckId });

    const deck = await getDeckById(orgA, deckId);
    expect(deck.status).toBe('READY');
    expect(deck.slideCount).toBe(4);
  });

  it('a deck whose plan has no approved budget version still reaches READY with 4 slides', async () => {
    const agent = await loginAgent(app, userA);
    const juneId = await onboardAndGenerateJune(agent);
    const planId = await createPlanWithNoApprovedVersion(agent);

    const created = await agent.post(DECKS).send({ title: 'Unapproved Plan Deck', fiscalPeriodId: juneId, planId });
    const deckId = created.body.deck.id as string;

    await handleBoardDeckGenerate({ orgId: orgA, deckId });

    const deck = await getDeckById(orgA, deckId);
    expect(deck.status).toBe('READY');
    expect(deck.slideCount).toBe(4);
  });

  it('a second generate job for the same deck is a no-op', async () => {
    const agent = await loginAgent(app, userA);
    const juneId = await onboardAndGenerateJune(agent);

    const created = await agent.post(DECKS).send({ title: 'Deck', fiscalPeriodId: juneId, planId: null });
    const deckId = created.body.deck.id as string;

    await handleBoardDeckGenerate({ orgId: orgA, deckId });
    const first = await getDeckById(orgA, deckId);

    await handleBoardDeckGenerate({ orgId: orgA, deckId });
    const second = await getDeckById(orgA, deckId);

    expect(second.generatedAt).toBe(first.generatedAt);
  });

  it('a builder failure marks the deck FAILED and re-throws', async () => {
    const agent = await loginAgent(app, userA);
    const juneId = await onboardAndGenerateJune(agent);

    const created = await agent.post(DECKS).send({ title: 'Deck', fiscalPeriodId: juneId, planId: null });
    const deckId = created.body.deck.id as string;

    vi.spyOn(deckBuilderService, 'buildDeck').mockRejectedValue(new Error('boom'));

    await expect(handleBoardDeckGenerate({ orgId: orgA, deckId })).rejects.toThrow('boom');

    const deck = await getDeckById(orgA, deckId);
    expect(deck.status).toBe('FAILED');
    expect(deck.errorMessage).toBe('boom');
  });

  it('GET /decks/:id/download on a READY deck returns 200 with the pptx content type', async () => {
    const agent = await loginAgent(app, userA);
    const juneId = await onboardAndGenerateJune(agent);
    const created = await agent.post(DECKS).send({ title: 'Deck', fiscalPeriodId: juneId, planId: null });
    const deckId = created.body.deck.id as string;
    await handleBoardDeckGenerate({ orgId: orgA, deckId });

    const res = await agent.get(`${DECKS}/${deckId}/download`).buffer(true).parse((response, callback) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    const body = res.body as Buffer;
    expect(body.subarray(0, 2).toString()).toBe('PK');
  });

  it('GET /decks/:id/download on a PENDING deck returns 409', async () => {
    const agent = await loginAgent(app, userA);
    const juneId = await onboardAndGenerateJune(agent);
    const created = await agent.post(DECKS).send({ title: 'Deck', fiscalPeriodId: juneId, planId: null });
    const deckId = created.body.deck.id as string;

    const res = await agent.get(`${DECKS}/${deckId}/download`);
    expect(res.status).toBe(409);
  });

  it('POST /decks/:id/retry on a READY deck returns 409', async () => {
    const agent = await loginAgent(app, userA);
    const juneId = await onboardAndGenerateJune(agent);
    const created = await agent.post(DECKS).send({ title: 'Deck', fiscalPeriodId: juneId, planId: null });
    const deckId = created.body.deck.id as string;
    await handleBoardDeckGenerate({ orgId: orgA, deckId });

    const res = await agent.post(`${DECKS}/${deckId}/retry`).send({});
    expect(res.status).toBe(409);
  });

  it('an ACCOUNTANT calling DELETE /decks/:id gets 403', async () => {
    const ownerAgent = await loginAgent(app, userA);
    const juneId = await onboardAndGenerateJune(ownerAgent);
    const created = await ownerAgent.post(DECKS).send({ title: 'Deck', fiscalPeriodId: juneId, planId: null });
    const deckId = created.body.deck.id as string;

    const accountant = await createUserWithOrg({ label: 'ash', orgName: 'Org Ash Solo' });
    await addMember(orgA, accountant.id, 'ACCOUNTANT');
    const accountantAgent = await loginAgent(app, accountant);
    await switchTo(accountantAgent, orgA);

    const res = await accountantAgent.delete(`${DECKS}/${deckId}`);
    expect(res.status).toBe(403);
  });

  it("GET /decks/:id with org B's deck id under org A's token returns 404", async () => {
    const agentB = await loginAgent(app, userB);
    const juneIdB = await onboardAndGenerateJune(agentB);
    const createdB = await agentB.post(DECKS).send({ title: 'Deck B', fiscalPeriodId: juneIdB, planId: null });
    const deckIdB = createdB.body.deck.id as string;

    const agentA = await loginAgent(app, userA);
    const res = await agentA.get(`${DECKS}/${deckIdB}`);
    expect(res.status).toBe(404);
  });

  it("GET /decks/:id/download with org B's deck id under org A's token returns 404 and streams no bytes", async () => {
    const agentB = await loginAgent(app, userB);
    const juneIdB = await onboardAndGenerateJune(agentB);
    const createdB = await agentB.post(DECKS).send({ title: 'Deck B', fiscalPeriodId: juneIdB, planId: null });
    const deckIdB = createdB.body.deck.id as string;
    await handleBoardDeckGenerate({ orgId: orgB, deckId: deckIdB });

    const agentA = await loginAgent(app, userA);
    const res = await agentA.get(`${DECKS}/${deckIdB}/download`);
    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('sha256');
  });

  it("a deck row for org B is never returned by org A's GET /decks", async () => {
    const agentA = await loginAgent(app, userA);
    await onboardAndGenerateJune(agentA);
    const before = await agentA.get(DECKS);
    const countBefore = before.body.count as number;

    const agentB = await loginAgent(app, userB);
    const juneIdB = await onboardAndGenerateJune(agentB);
    await agentB.post(DECKS).send({ title: 'B1', fiscalPeriodId: juneIdB, planId: null });
    await agentB.post(DECKS).send({ title: 'B2', fiscalPeriodId: juneIdB, planId: null });
    await agentB.post(DECKS).send({ title: 'B3', fiscalPeriodId: juneIdB, planId: null });

    const after = await agentA.get(DECKS);
    expect(after.body.count).toBe(countBefore);
  });
});
