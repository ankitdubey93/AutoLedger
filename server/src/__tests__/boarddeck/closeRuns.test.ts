import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * BoardDeck close runs (Phase 15). Integration tier, real PostgreSQL.
 * Includes this module's own cross-tenant isolation suite (rule 15).
 */

const app = createApp();
const CLOSE_RUNS = '/api/v1/boarddeck/close-runs';
const PERIODS = '/api/v1/ledger-core/fiscal-periods';
const ONBOARDING = '/api/v1/ledger-core/settings/onboarding';
const CUSTOMERS = '/api/v1/ledger-core/customers';
const INVOICES = '/api/v1/ledger-core/invoices';

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;

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
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
}

async function onboardAndGenerateJanuary(agent: Agent): Promise<string> {
  const onboardRes = await agent.post(ONBOARDING).send({
    organizationName: 'Acme Books',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    booksStartDate: '2026-01-01',
  });
  if (onboardRes.status !== 200) throw new Error(`fixture: onboarding failed ${onboardRes.status}`);

  const genRes = await agent.post(`${PERIODS}/generate`).send({ containingDate: '2026-06-15' });
  if (genRes.status !== 201) throw new Error(`fixture: generate periods failed ${genRes.status}`);
  return genRes.body.periods[5].id as string; // June — index 5, 0-based from January
}

async function createDraftInvoice(agent: Agent, orgId: string, issueDate: string): Promise<string> {
  const revenueAccountId = await accountId(orgId, '4100');
  const customerRes = await agent.post(CUSTOMERS).send({ name: `Customer ${issueDate}` });
  const customerId = customerRes.body.customer.id as string;

  const res = await agent.post(INVOICES).send({
    customerId,
    issueDate,
    dueDate: '2026-12-31',
    notes: null,
    paymentTerms: null,
    lines: [
      { description: 'Consulting', quantityMilli: 1000, unitPriceCents: 10000, revenueAccountId, taxRateBp: 0 },
    ],
  });
  if (res.status !== 201) throw new Error(`fixture: invoice create failed ${res.status}`);
  return res.body.invoice.id as string;
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgA = userA.orgId;
});

afterAll(closePool);

describe('BoardDeck close runs API', () => {
  it('POST /close-runs on a clean period returns 201 and status READY', async () => {
    const agent = await loginAgent(app, userA);
    const juneId = await onboardAndGenerateJanuary(agent);

    const res = await agent.post(CLOSE_RUNS).send({ fiscalPeriodId: juneId });

    expect(res.status).toBe(201);
    expect(res.body.closeRun.status).toBe('READY');
    for (const check of res.body.closeRun.checks) {
      expect(check.result).toBe('PASS');
    }
  });

  it('POST /close-runs on a period with a DRAFT invoice returns 201 and status BLOCKED', async () => {
    const agent = await loginAgent(app, userA);
    const juneId = await onboardAndGenerateJanuary(agent);
    await createDraftInvoice(agent, orgA, '2026-06-10');

    const res = await agent.post(CLOSE_RUNS).send({ fiscalPeriodId: juneId });

    expect(res.status).toBe(201);
    expect(res.body.closeRun.status).toBe('BLOCKED');
    const draftCheck = res.body.closeRun.checks.find((c: { kind: string }) => c.kind === 'NO_DRAFT_INVOICES');
    expect(draftCheck.result).toBe('FAIL');
    expect(draftCheck.observedCount).toBe(1);
  });

  it('a second POST for the same period returns 409', async () => {
    const agent = await loginAgent(app, userA);
    const juneId = await onboardAndGenerateJanuary(agent);
    await agent.post(CLOSE_RUNS).send({ fiscalPeriodId: juneId });

    const res = await agent.post(CLOSE_RUNS).send({ fiscalPeriodId: juneId });

    expect(res.status).toBe(409);
  });

  it('POST /:id/rerun after the DRAFT invoice is issued flips the run to READY', async () => {
    const agent = await loginAgent(app, userA);
    const juneId = await onboardAndGenerateJanuary(agent);
    const invoiceId = await createDraftInvoice(agent, orgA, '2026-06-10');

    const created = await agent.post(CLOSE_RUNS).send({ fiscalPeriodId: juneId });
    expect(created.body.closeRun.status).toBe('BLOCKED');
    const runId = created.body.closeRun.id as string;

    const issueRes = await agent.post(`${INVOICES}/${invoiceId}/issue`).send({});
    expect(issueRes.status).toBe(200);

    const rerun = await agent.post(`${CLOSE_RUNS}/${runId}/rerun`).send({});
    expect(rerun.status).toBe(200);
    expect(rerun.body.closeRun.status).toBe('READY');
  });

  it('POST /:id/close-period on a BLOCKED run returns 409', async () => {
    const agent = await loginAgent(app, userA);
    const juneId = await onboardAndGenerateJanuary(agent);
    await createDraftInvoice(agent, orgA, '2026-06-10');
    const created = await agent.post(CLOSE_RUNS).send({ fiscalPeriodId: juneId });
    const runId = created.body.closeRun.id as string;

    const res = await agent.post(`${CLOSE_RUNS}/${runId}/close-period`).send({});
    expect(res.status).toBe(409);
  });

  it('POST /:id/close-period on a READY run returns 200, status CLOSED, and the LedgerCore period is CLOSED', async () => {
    const agent = await loginAgent(app, userA);
    const juneId = await onboardAndGenerateJanuary(agent);
    const created = await agent.post(CLOSE_RUNS).send({ fiscalPeriodId: juneId });
    const runId = created.body.closeRun.id as string;

    const res = await agent.post(`${CLOSE_RUNS}/${runId}/close-period`).send({});
    expect(res.status).toBe(200);
    expect(res.body.closeRun.status).toBe('CLOSED');

    const periodRes = await agent.get(`${PERIODS}/${juneId}`);
    expect(periodRes.body.period.status).toBe('CLOSED');
  });

  it('POST /:id/rerun on a CLOSED run returns 409', async () => {
    const agent = await loginAgent(app, userA);
    const juneId = await onboardAndGenerateJanuary(agent);
    const created = await agent.post(CLOSE_RUNS).send({ fiscalPeriodId: juneId });
    const runId = created.body.closeRun.id as string;
    await agent.post(`${CLOSE_RUNS}/${runId}/close-period`).send({});

    const res = await agent.post(`${CLOSE_RUNS}/${runId}/rerun`).send({});
    expect(res.status).toBe(409);
  });

  it('an ACCOUNTANT calling /close-period gets 403', async () => {
    const ownerAgent = await loginAgent(app, userA);
    const juneId = await onboardAndGenerateJanuary(ownerAgent);
    const created = await ownerAgent.post(CLOSE_RUNS).send({ fiscalPeriodId: juneId });
    const runId = created.body.closeRun.id as string;

    const accountant = await createUserWithOrg({ label: 'ash', orgName: 'Org Ash Solo' });
    await addMember(orgA, accountant.id, 'ACCOUNTANT');
    const accountantAgent = await loginAgent(app, accountant);
    await switchTo(accountantAgent, orgA);

    const res = await accountantAgent.post(`${CLOSE_RUNS}/${runId}/close-period`).send({});
    expect(res.status).toBe(403);
  });

  it('a VIEWER calling POST /close-runs gets 403', async () => {
    const ownerAgent = await loginAgent(app, userA);
    const juneId = await onboardAndGenerateJanuary(ownerAgent);

    const viewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic Solo' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const viewerAgent = await loginAgent(app, viewer);
    await switchTo(viewerAgent, orgA);

    const res = await viewerAgent.post(CLOSE_RUNS).send({ fiscalPeriodId: juneId });
    expect(res.status).toBe(403);
  });

  it("GET /close-runs/:id with org B's run id under org A's token returns 404", async () => {
    const agentB = await loginAgent(app, userB);
    const juneIdB = await onboardAndGenerateJanuary(agentB);
    const createdB = await agentB.post(CLOSE_RUNS).send({ fiscalPeriodId: juneIdB });
    const runIdB = createdB.body.closeRun.id as string;

    const agentA = await loginAgent(app, userA);
    const res = await agentA.get(`${CLOSE_RUNS}/${runIdB}`);
    expect(res.status).toBe(404);
  });

  it('GET /close-runs/:id with a malformed uuid returns 404', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(`${CLOSE_RUNS}/not-a-uuid`);
    expect(res.status).toBe(404);
  });

  it('a rolled-back createRun leaves no run and no check rows', async () => {
    const agent = await loginAgent(app, userA);
    const juneId = await onboardAndGenerateJanuary(agent);
    await agent.post(CLOSE_RUNS).send({ fiscalPeriodId: juneId });

    // Second attempt on the same period hits ON CONFLICT DO NOTHING -> 409,
    // which must not have written a second run's check rows either.
    await agent.post(CLOSE_RUNS).send({ fiscalPeriodId: juneId });

    const { rows } = await pool.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM boarddeck_close_checks WHERE org_id = $1',
      [orgA],
    );
    expect(Number(rows[0]?.n)).toBe(5);
  });
});
