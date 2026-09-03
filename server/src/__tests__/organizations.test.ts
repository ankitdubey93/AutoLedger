import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { closePool } from '../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from './helpers/factories.js';
import type { SeededUser } from './helpers/factories.js';

/**
 * /api/v1/organizations — PATCH's tax and business registration numbers
 * (Phase 3.8). The route's other behaviour (name/baseCurrency, member listing,
 * role gating for OWNER/ADMIN) is already covered incidentally by
 * ledger-core/settings.test.ts; this file is the dedicated home for the new
 * fields and their cross-tenant isolation, per guardrails rule 15.
 */

const app = createApp();
const ORGANIZATIONS = '/api/v1/organizations';

let userA: SeededUser;
let userC: SeededUser;
let orgA: string;
let orgB: string;

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userC = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userC.orgId;
});

afterAll(closePool);

describe('PATCH /organizations — tax and business numbers', () => {
  it('sets taxNumber and businessNumber', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent
      .patch(ORGANIZATIONS)
      .send({ taxNumber: '29AABCU9603R1ZM', businessNumber: 'U72200KA2015PTC012345' });

    expect(res.status).toBe(200);
    expect(res.body.organization.taxNumber).toBe('29AABCU9603R1ZM');
    expect(res.body.organization.businessNumber).toBe('U72200KA2015PTC012345');
  });

  it('accepts null to clear taxNumber', async () => {
    const agent = await loginAgent(app, userA);
    await agent.patch(ORGANIZATIONS).send({ taxNumber: '29AABCU9603R1ZM' });

    const res = await agent.patch(ORGANIZATIONS).send({ taxNumber: null });

    expect(res.status).toBe(200);
    expect(res.body.organization.taxNumber).toBeNull();
  });

  it('rejects a taxNumber over 64 characters', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.patch(ORGANIZATIONS).send({ taxNumber: 'x'.repeat(65) });

    expect(res.status).toBe(400);
  });

  it('rejects the request from an ACCOUNTANT', async () => {
    const accountant = await createUserWithOrg({ label: 'dana', orgName: 'Org Dana' });
    await addMember(orgA, accountant.id, 'ACCOUNTANT');
    const agent = await loginAgent(app, accountant);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const res = await agent.patch(ORGANIZATIONS).send({ taxNumber: '29AABCU9603R1ZM' });

    expect(res.status).toBe(403);
  });

  it("org A's PATCH never touches org B", async () => {
    const agentA = await loginAgent(app, userA);
    await agentA.patch(ORGANIZATIONS).send({ taxNumber: '29AABCU9603R1ZM' });

    const agentC = await loginAgent(app, userC);
    const res = await agentC.get(ORGANIZATIONS);

    expect(res.status).toBe(200);
    expect(res.body.organization.taxNumber).toBeNull();
    expect(orgB).not.toBe(orgA);
  });
});
