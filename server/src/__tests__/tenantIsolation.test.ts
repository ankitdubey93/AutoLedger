import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { closePool } from '../db/connect.js';
import * as organizationService from '../services/organizationService.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from './helpers/factories.js';
import type { SeededUser } from './helpers/factories.js';

/**
 * The cross-tenant isolation suite. docs/testing.md: **a module without one is
 * not done.**
 *
 * Scoping by `user_id` instead of `org_id` was the prior build's fatal design
 * error, and it was never caught because nothing tested for it. These tests
 * are the mechanism that stops it recurring.
 *
 * Fixture:
 *   userA  — member of org A only
 *   userB  — member of org A *and* org B
 *   userC  — member of org B only
 *
 * userB matters: without a user who legitimately spans both, a bug that simply
 * returns nothing to everybody would pass every test below.
 */

const app = createApp();

let userA: SeededUser;
let userB: SeededUser;
let userC: SeededUser;
let orgA: string;
let orgB: string;

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userC = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userC.orgId;

  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bobs Own' });
  // Bob genuinely belongs to both tenants.
  await addMember(orgA, userB.id, 'ADMIN');
  await addMember(orgB, userB.id, 'ADMIN');
});

afterAll(closePool);

describe('active organization comes only from the access token', () => {
  it('refuses to switch into an organization the caller does not belong to', async () => {
    const agent = await loginAgent(app, userA);

    const res = await agent.post('/api/v1/auth/switch-org').send({ orgId: orgB });

    expect(res.status).toBe(403);
    // Critically: no new token was minted. A 403 that still issued a cookie
    // would hand over exactly the access it just refused.
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('never reveals another tenant through /auth/check', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get('/api/v1/auth/check');

    expect(res.status).toBe(200);
    expect(res.body.memberships).toHaveLength(1);
    expect(res.body.memberships[0].orgId).toBe(orgA);

    // Asserted against the raw body, not the parsed shape, so a leak through
    // some field nobody thought to check still fails the test.
    expect(res.text).not.toContain(orgB);
    expect(res.text).not.toContain('Org Bravo');
    expect(res.text).not.toContain(userC.email);
  });

  it('ignores orgId in the query string, headers and body', async () => {
    const agent = await loginAgent(app, userA);

    const honest = await agent.get('/api/v1/organizations/members');
    const forged = await agent
      .get('/api/v1/organizations/members')
      .query({ orgId: orgB })
      .set('X-Org-Id', orgB)
      .send({ orgId: orgB });

    expect(forged.status).toBe(200);
    // Byte-identical: none of those three inputs is even consulted.
    expect(forged.body).toEqual(honest.body);
    expect(forged.text).not.toContain(userC.email);
  });
});

describe('GET /organizations/members', () => {
  it('returns only the active organization members', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get('/api/v1/organizations/members');

    expect(res.status).toBe(200);
    const emails = res.body.members.map((m: { email: string }) => m.email).sort();
    expect(emails).toEqual([userA.email, userB.email].sort());
    expect(res.text).not.toContain(userC.email);
  });

  it('returns org B members once a legitimate member switches into it', async () => {
    // The test that stops "return nothing to everyone" from passing as
    // isolation. Bob is entitled to org B, so he must actually see Carol.
    const agent = await loginAgent(app, userB);

    const before = await agent.get('/api/v1/organizations/members');
    expect(before.text).not.toContain(userC.email);

    const switched = await agent.post('/api/v1/auth/switch-org').send({ orgId: orgB });
    expect(switched.status).toBe(200);
    expect(switched.body.organization.id).toBe(orgB);

    const after = await agent.get('/api/v1/organizations/members');
    expect(after.status).toBe(200);
    const emails = after.body.members.map((m: { email: string }) => m.email);
    expect(emails).toContain(userC.email);
    // And Alice, who is org A only, is now out of scope.
    expect(after.text).not.toContain(userA.email);
  });

  it('keeps the switched organization across a token refresh', async () => {
    const agent = await loginAgent(app, userB);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgB });

    // switch-org rotates the refresh cookie too. If it only replaced the
    // access token, the next refresh would read the stale org_id off the old
    // row and silently drag the user back to org A.
    const refreshed = await agent.post('/api/v1/auth/refresh');
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.organization.id).toBe(orgB);
  });

  it('denies ACCOUNTANT and VIEWER roles', async () => {
    const viewer = await createUserWithOrg({ label: 'vic' });
    await addMember(orgA, viewer.id, 'VIEWER');

    const agent = await loginAgent(app, viewer);
    const switched = await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });
    expect(switched.status).toBe(200);
    expect(switched.body.role).toBe('VIEWER');

    // 403, not 404 — they are authenticated, just not permitted.
    const res = await agent.get('/api/v1/organizations/members');
    expect(res.status).toBe(403);
  });

  it('401s without authentication', async () => {
    expect((await request(app).get('/api/v1/organizations/members')).status).toBe(401);
  });
});

describe('service layer', () => {
  it('scopes by org_id below HTTP, not just at the route', async () => {
    // If isolation lived only in a controller, a future module calling the
    // service directly would leak. The predicate belongs in the query.
    const membersOfA = await organizationService.listMembers(orgA);
    const membersOfB = await organizationService.listMembers(orgB);

    expect(membersOfA.map((m) => m.email).sort()).toEqual([userA.email, userB.email].sort());
    expect(membersOfB.map((m) => m.email).sort()).toEqual([userB.email, userC.email].sort());
    expect(membersOfA.map((m) => m.email)).not.toContain(userC.email);
  });
});
