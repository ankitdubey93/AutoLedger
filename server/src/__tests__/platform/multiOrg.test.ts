import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import * as organizationService from '../../services/organizationService.js';
import { MAX_OWNED_ORGANIZATIONS } from '../../config/constants.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Phase 37 — one user, several organizations: creating another, landing in
 * the last-used one at login, leaving, and member administration with the
 * "at least one OWNER" invariant. Invitations are in invitations.test.ts.
 */

const app = createApp();

let alice: SeededUser;

beforeEach(async () => {
  await resetTables();
  alice = await createUserWithOrg({ label: 'alice', orgName: 'Alpha Ltd' });
});

afterAll(closePool);

describe('POST /auth/organizations', () => {
  it('creates an owned, seeded, not-yet-onboarded organization and moves the session into it', async () => {
    const agent = await loginAgent(app, alice);
    await agent.post('/api/v1/customers').send({ name: 'Alpha Customer' }).expect(201);

    const res = await agent.post('/api/v1/auth/organizations').send({ name: 'Beta Ltd' });

    expect(res.status).toBe(201);
    expect(res.body.organization.name).toBe('Beta Ltd');
    expect(res.body.role).toBe('OWNER');
    expect(res.body.memberships.map((m: { orgName: string }) => m.orgName)).toEqual(['Alpha Ltd', 'Beta Ltd']);
    const betaId: string = res.body.organization.id;

    // The new session is in Beta: its own chart and payment terms, no
    // settings yet (so the client's setup gate shows the wizard), and none of
    // Alpha's data.
    const accounts = await agent.get('/api/v1/accounts');
    expect(accounts.body.count).toBeGreaterThan(0);
    const terms = await agent.get('/api/v1/payment-terms');
    expect(terms.body.count).toBe(7);
    const settings = await agent.get('/api/v1/settings');
    expect(settings.body.settings.onboardedAt).toBeNull();
    const customers = await agent.get('/api/v1/customers');
    expect(customers.body.count).toBe(0);

    // The rotated session survives a refresh in Beta.
    const refreshed = await agent.post('/api/v1/auth/refresh');
    expect(refreshed.body.organization.id).toBe(betaId);
  });

  it('retires the presented refresh token rather than leaving it behind', async () => {
    const agent = await loginAgent(app, alice);
    await agent.post('/api/v1/auth/organizations').send({ name: 'Beta Ltd' }).expect(201);

    const { rows } = await pool.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM refresh_tokens WHERE user_id = $1',
      [alice.id],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('validates the name', async () => {
    const agent = await loginAgent(app, alice);
    const res = await agent.post('/api/v1/auth/organizations').send({ name: ' ' });
    expect(res.status).toBe(400);
  });

  it('requires a session', async () => {
    const res = await request(app).post('/api/v1/auth/organizations').send({ name: 'Beta Ltd' });
    expect(res.status).toBe(401);
  });

  it('caps how many organizations one user may own', async () => {
    const agent = await loginAgent(app, alice);
    // Alice already owns one.
    for (let i = 1; i < MAX_OWNED_ORGANIZATIONS; i += 1) {
      await agent.post('/api/v1/auth/organizations').send({ name: `Org ${String(i)}` }).expect(201);
    }
    const res = await agent.post('/api/v1/auth/organizations').send({ name: 'One too many' });
    expect(res.status).toBe(422);
  });
});

describe('login opens the last-used organization', () => {
  it('lands in the organization the user switched to last', async () => {
    const agent = await loginAgent(app, alice);
    const beta = await agent.post('/api/v1/auth/organizations').send({ name: 'Beta Ltd' });
    const betaId: string = beta.body.organization.id;

    const again = await request(app).post('/api/v1/auth/login').send({ email: alice.email, password: alice.password });
    expect(again.body.organization.id).toBe(betaId);

    const relogged = await loginAgent(app, alice);
    await relogged.post('/api/v1/auth/switch-org').send({ orgId: alice.orgId }).expect(200);
    const third = await request(app).post('/api/v1/auth/login').send({ email: alice.email, password: alice.password });
    expect(third.body.organization.id).toBe(alice.orgId);
  });

  it('falls back to the oldest membership once the last-used one is gone', async () => {
    const bob = await createUserWithOrg({ label: 'bob', orgName: 'Bob Co' });
    await addMember(alice.orgId, bob.id, 'ACCOUNTANT');
    const bobAgent = await loginAgent(app, bob);
    await bobAgent.post('/api/v1/auth/switch-org').send({ orgId: alice.orgId }).expect(200);

    const aliceAgent = await loginAgent(app, alice);
    await aliceAgent.delete(`/api/v1/organizations/members/${bob.id}`).expect(200);

    const res = await request(app).post('/api/v1/auth/login').send({ email: bob.email, password: bob.password });
    expect(res.body.organization.id).toBe(bob.orgId);
  });
});

describe('POST /auth/leave-org', () => {
  it('removes the membership and moves the session to another organization', async () => {
    const bob = await createUserWithOrg({ label: 'bob', orgName: 'Bob Co' });
    await addMember(alice.orgId, bob.id, 'ADMIN');
    const agent = await loginAgent(app, bob);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: alice.orgId }).expect(200);

    const res = await agent.post('/api/v1/auth/leave-org');

    expect(res.status).toBe(200);
    expect(res.body.organization.id).toBe(bob.orgId);
    expect(res.body.memberships).toHaveLength(1);
  });

  it("refuses to leave a user's only organization", async () => {
    const bob = await createUserWithOrg({ label: 'bob' });
    await pool.query("UPDATE organization_members SET role = 'ADMIN' WHERE user_id = $1", [bob.id]);
    await addMember(bob.orgId, alice.id, 'OWNER');
    const agent = await loginAgent(app, bob);
    const res = await agent.post('/api/v1/auth/leave-org');
    expect(res.status).toBe(422);
  });

  it('refuses to leave as the last owner', async () => {
    const agent = await loginAgent(app, alice);
    await agent.post('/api/v1/auth/organizations').send({ name: 'Beta Ltd' }).expect(201);
    const res = await agent.post('/api/v1/auth/leave-org');
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/at least one owner/);
  });
});

describe('member administration', () => {
  let bob: SeededUser;

  beforeEach(async () => {
    bob = await createUserWithOrg({ label: 'bob', orgName: 'Bob Co' });
    await addMember(alice.orgId, bob.id, 'ADMIN');
  });

  it('lets an owner change a role', async () => {
    const agent = await loginAgent(app, alice);
    const res = await agent.patch(`/api/v1/organizations/members/${bob.id}`).send({ role: 'VIEWER' });
    expect(res.status).toBe(200);
    expect(res.body.member.role).toBe('VIEWER');
  });

  it('does not let an admin grant, change or remove the owner role', async () => {
    const bobAgent = await loginAgent(app, bob);
    await bobAgent.post('/api/v1/auth/switch-org').send({ orgId: alice.orgId }).expect(200);

    expect((await bobAgent.patch(`/api/v1/organizations/members/${bob.id}`).send({ role: 'OWNER' })).status).toBe(403);
    expect((await bobAgent.patch(`/api/v1/organizations/members/${alice.id}`).send({ role: 'VIEWER' })).status).toBe(
      403,
    );
    expect((await bobAgent.delete(`/api/v1/organizations/members/${alice.id}`)).status).toBe(403);
  });

  it('refuses to demote the last owner', async () => {
    const agent = await loginAgent(app, alice);
    const res = await agent.patch(`/api/v1/organizations/members/${alice.id}`).send({ role: 'ADMIN' });
    expect(res.status).toBe(422);
  });

  it('refuses to remove yourself through the members route', async () => {
    const agent = await loginAgent(app, alice);
    const res = await agent.delete(`/api/v1/organizations/members/${alice.id}`);
    expect(res.status).toBe(422);
  });

  it('keeps exactly one owner when two owners demote each other at the same time', async () => {
    await pool.query("UPDATE organization_members SET role = 'OWNER' WHERE org_id = $1 AND user_id = $2", [
      alice.orgId,
      bob.id,
    ]);
    const results = await Promise.allSettled([
      organizationService.updateMemberRole(alice.orgId, { id: alice.id }, bob.id, { role: 'ADMIN', customRoleId: null }),
      organizationService.updateMemberRole(alice.orgId, { id: bob.id }, alice.id, { role: 'ADMIN', customRoleId: null }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const { rows } = await pool.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM organization_members WHERE org_id = $1 AND role = 'OWNER'",
      [alice.orgId],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("judges the actor by their current role, not the one in a still-valid access token", async () => {
    await pool.query("UPDATE organization_members SET role = 'OWNER' WHERE org_id = $1 AND user_id = $2", [
      alice.orgId,
      bob.id,
    ]);
    const bobAgent = await loginAgent(app, bob);
    await bobAgent.post('/api/v1/auth/switch-org').send({ orgId: alice.orgId }).expect(200);
    // Bob's token now says OWNER; Alice demotes him to ADMIN.
    const aliceAgent = await loginAgent(app, alice);
    await aliceAgent.patch(`/api/v1/organizations/members/${bob.id}`).send({ role: 'ADMIN' }).expect(200);

    const res = await bobAgent.patch(`/api/v1/organizations/members/${alice.id}`).send({ role: 'VIEWER' });
    expect(res.status).toBe(403);
    const invite = await bobAgent.post('/api/v1/organizations/invitations').send({ email: 'o@example.com', role: 'OWNER' });
    expect(invite.status).toBe(403);
  });

  it('rejects a malformed member id with 400', async () => {
    const agent = await loginAgent(app, alice);
    const res = await agent.patch('/api/v1/organizations/members/not-a-uuid').send({ role: 'VIEWER' });
    expect(res.status).toBe(400);
  });

  it("cannot touch another organization's members (cross-tenant)", async () => {
    // Carol administers her own org only; Bob is in Alpha and Bob Co.
    const carol = await createUserWithOrg({ label: 'carol', orgName: 'Carol Co' });
    const carolAgent = await loginAgent(app, carol);

    expect((await carolAgent.patch(`/api/v1/organizations/members/${bob.id}`).send({ role: 'VIEWER' })).status).toBe(
      404,
    );
    expect((await carolAgent.delete(`/api/v1/organizations/members/${bob.id}`)).status).toBe(404);

    const { rows } = await pool.query<{ role: string }>(
      'SELECT role FROM organization_members WHERE org_id = $1 AND user_id = $2',
      [alice.orgId, bob.id],
    );
    expect(rows[0]?.role).toBe('ADMIN');
  });

  it('is closed to accountants and viewers', async () => {
    const dave = await createUserWithOrg({ label: 'dave' });
    await addMember(alice.orgId, dave.id, 'ACCOUNTANT');
    const agent = await loginAgent(app, dave);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: alice.orgId }).expect(200);
    expect((await agent.patch(`/api/v1/organizations/members/${bob.id}`).send({ role: 'VIEWER' })).status).toBe(403);
  });
});
