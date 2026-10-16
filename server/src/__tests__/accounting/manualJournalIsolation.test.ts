import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId } from '../helpers/accountingFixtures.js';

/**
 * Accounting — manual journals, cross-tenant isolation (rule 15). Org A owns
 * a draft and a posted journal; org B's token must get 404 (never 403) on
 * every route and never see them in its list.
 */

const app = createApp();
const M = '/api/v1/manual-journals';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let userB: SeededUser;
let agentA: Agent;
let agentB: Agent;
let draftId: string;
let postedId: string;
let validBody: Record<string, unknown>;

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'mj-iso-a', orgName: 'MJ Iso A' });
  userB = await createUserWithOrg({ label: 'mj-iso-b', orgName: 'MJ Iso B' });
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);

  validBody = {
    narration: 'Isolation',
    entryDate: '2026-03-15',
    lines: [
      { accountId: await accountId(userA.orgId, '6120'), description: null, debitCents: 100, creditCents: 0 },
      { accountId: await accountId(userA.orgId, '2120'), description: null, debitCents: 0, creditCents: 100 },
    ],
  };
  const d = await agentA.post(M).send({ ...validBody, action: 'draft' });
  const p = await agentA.post(M).send({ ...validBody, action: 'post' });
  if (d.status !== 201 || p.status !== 201) throw new Error('fixture: journals not created');
  draftId = d.body.journal.id as string;
  postedId = p.body.journal.id as string;
});

afterAll(closePool);

describe("org B cannot reach org A's manual journals", () => {
  it('GET /:id -> 404', async () => {
    expect((await agentB.get(`${M}/${draftId}`)).status).toBe(404);
    expect((await agentB.get(`${M}/${postedId}`)).status).toBe(404);
  });

  it('PATCH /:id -> 404', async () => {
    expect((await agentB.patch(`${M}/${draftId}`).send(validBody)).status).toBe(404);
  });

  it('DELETE /:id -> 404, and the draft survives', async () => {
    expect((await agentB.delete(`${M}/${draftId}`)).status).toBe(404);
    expect((await agentA.get(`${M}/${draftId}`)).status).toBe(200);
  });

  it('POST /:id/post -> 404, and the draft stays DRAFT', async () => {
    expect((await agentB.post(`${M}/${draftId}/post`).send({})).status).toBe(404);
    expect((await agentA.get(`${M}/${draftId}`)).body.journal.status).toBe('DRAFT');
  });

  it('POST /:id/void -> 404, and the posted journal stays POSTED', async () => {
    expect((await agentB.post(`${M}/${postedId}/void`).send({})).status).toBe(404);
    expect((await agentA.get(`${M}/${postedId}`)).body.journal.status).toBe('POSTED');
  });

  it("never appears in org B's list", async () => {
    const res = await agentB.get(M);
    expect(res.status).toBe(200);
    expect(res.body.totalCount).toBe(0);
    expect(res.body.journals).toEqual([]);
    expect(res.body.counts).toEqual({ all: 0, draft: 0, posted: 0, voided: 0 });
  });
});
