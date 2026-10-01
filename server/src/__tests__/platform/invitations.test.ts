import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables, uniqueEmail } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Phase 37 — invitations into an organization, including the cross-tenant
 * isolation rule 15 requires: another organization's admin can neither see
 * nor revoke this organization's invitations.
 */

const app = createApp();

let alice: SeededUser;

beforeEach(async () => {
  await resetTables();
  alice = await createUserWithOrg({ label: 'alice', orgName: 'Alpha Ltd' });
});

afterAll(closePool);

function tokenOf(acceptUrl: string): string {
  const token = new URL(acceptUrl).pathname.split('/').pop();
  if (token === undefined || token === '') throw new Error(`no token in ${acceptUrl}`);
  return token;
}

async function invite(email: string, role = 'ACCOUNTANT') {
  const agent = await loginAgent(app, alice);
  const res = await agent.post('/api/v1/organizations/invitations').send({ email, role });
  expect(res.status).toBe(201);
  return { agent, invitationId: res.body.invitation.id as string, token: tokenOf(res.body.acceptUrl as string) };
}

describe('creating and listing invitations', () => {
  it('returns the link once, lowercases the email and stores only the token hash', async () => {
    const { agent, token } = await invite('New.Person@Example.com');

    const list = await agent.get('/api/v1/organizations/invitations');
    expect(list.body.invitations).toHaveLength(1);
    expect(list.body.invitations[0]).toMatchObject({ email: 'new.person@example.com', status: 'PENDING' });
    expect(list.text).not.toContain(token);

    const { rows } = await pool.query<{ token_hash: string }>('SELECT token_hash FROM organization_invitations');
    expect(rows[0]?.token_hash).not.toBe(token);
  });

  it('refuses an existing member and a second pending invite for the same address', async () => {
    const agent = await loginAgent(app, alice);
    expect((await agent.post('/api/v1/organizations/invitations').send({ email: alice.email, role: 'VIEWER' })).status).toBe(
      409,
    );
    await agent.post('/api/v1/organizations/invitations').send({ email: 'x@example.com', role: 'VIEWER' }).expect(201);
    expect((await agent.post('/api/v1/organizations/invitations').send({ email: 'X@example.com', role: 'VIEWER' })).status).toBe(
      409,
    );
  });

  it('lets an expired invitation be replaced', async () => {
    const { agent } = await invite('late@example.com');
    await pool.query("UPDATE organization_invitations SET created_at = now() - interval '9 days', expires_at = now() - interval '1 day'");
    const res = await agent.post('/api/v1/organizations/invitations').send({ email: 'late@example.com', role: 'VIEWER' });
    expect(res.status).toBe(201);
  });

  it('does not let an admin invite an owner', async () => {
    const bob = await createUserWithOrg({ label: 'bob' });
    await addMember(alice.orgId, bob.id, 'ADMIN');
    const agent = await loginAgent(app, bob);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: alice.orgId }).expect(200);
    const res = await agent.post('/api/v1/organizations/invitations').send({ email: 'o@example.com', role: 'OWNER' });
    expect(res.status).toBe(403);
  });

  it('is closed to accountants', async () => {
    const bob = await createUserWithOrg({ label: 'bob' });
    await addMember(alice.orgId, bob.id, 'ACCOUNTANT');
    const agent = await loginAgent(app, bob);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: alice.orgId }).expect(200);
    expect((await agent.get('/api/v1/organizations/invitations')).status).toBe(403);
    expect((await agent.post('/api/v1/organizations/invitations').send({ email: 'a@example.com', role: 'VIEWER' })).status).toBe(
      403,
    );
  });
});

describe('cross-tenant isolation', () => {
  it("never lists or revokes another organization's invitations", async () => {
    const { invitationId } = await invite('secret-hire@example.com');
    const carol = await createUserWithOrg({ label: 'carol', orgName: 'Carol Co' });
    const carolAgent = await loginAgent(app, carol);

    const list = await carolAgent.get('/api/v1/organizations/invitations');
    expect(list.body.invitations).toHaveLength(0);
    expect(list.text).not.toContain('secret-hire');

    expect((await carolAgent.delete(`/api/v1/organizations/invitations/${invitationId}`)).status).toBe(404);
    const { rows } = await pool.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM organization_invitations');
    expect(rows[0]?.revoked_at).toBeNull();
  });
});

describe('preview and accept', () => {
  it('previews publicly and refuses an unknown token', async () => {
    const { token } = await invite('bob@example.com');
    const res = await request(app).get(`/api/v1/auth/invitations/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.invitation).toMatchObject({ organizationName: 'Alpha Ltd', email: 'bob@example.com', status: 'PENDING' });

    expect((await request(app).get('/api/v1/auth/invitations/not-a-real-token')).status).toBe(404);
  });

  it('lets an existing user with the matching email accept and moves their session in', async () => {
    const bob = await createUserWithOrg({ label: 'bob', orgName: 'Bob Co' });
    const { token } = await invite(bob.email.toUpperCase(), 'ACCOUNTANT');
    const bobAgent = await loginAgent(app, bob);

    const res = await bobAgent.post(`/api/v1/auth/invitations/${token}/accept`);

    expect(res.status).toBe(200);
    expect(res.body.organization.id).toBe(alice.orgId);
    expect(res.body.role).toBe('ACCOUNTANT');
    expect(res.body.memberships).toHaveLength(2);

    // Used once; a second attempt is gone.
    expect((await bobAgent.post(`/api/v1/auth/invitations/${token}/accept`)).status).toBe(410);
    expect((await request(app).get(`/api/v1/auth/invitations/${token}`)).body.invitation.status).toBe('ACCEPTED');
  });

  it('refuses a signed-in user whose email does not match', async () => {
    const { token } = await invite('someone-else@example.com');
    const mallory = await createUserWithOrg({ label: 'mallory' });
    const agent = await loginAgent(app, mallory);
    const res = await agent.post(`/api/v1/auth/invitations/${token}/accept`);
    expect(res.status).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('refuses a revoked or expired invitation with 410', async () => {
    const bob = await createUserWithOrg({ label: 'bob' });
    const { agent, invitationId, token } = await invite(bob.email);
    await agent.delete(`/api/v1/organizations/invitations/${invitationId}`).expect(200);
    const bobAgent = await loginAgent(app, bob);
    expect((await bobAgent.post(`/api/v1/auth/invitations/${token}/accept`)).status).toBe(410);

    const carol = await createUserWithOrg({ label: 'carol' });
    const second = await invite(carol.email);
    await pool.query(
      "UPDATE organization_invitations SET created_at = now() - interval '9 days', expires_at = now() - interval '1 day' WHERE id = $1",
      [second.invitationId],
    );
    const carolAgent = await loginAgent(app, carol);
    expect((await carolAgent.post(`/api/v1/auth/invitations/${second.token}/accept`)).status).toBe(410);
  });

  it('requires a session to accept', async () => {
    const { token } = await invite('bob@example.com');
    expect((await request(app).post(`/api/v1/auth/invitations/${token}/accept`)).status).toBe(401);
  });
});

describe('POST /auth/register with an invitation', () => {
  it('creates the user inside the inviting organization and no organization of their own', async () => {
    const email = uniqueEmail('newbie');
    const { token } = await invite(email, 'VIEWER');

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Newbie', email, password: 'a-perfectly-fine-password', inviteToken: token });
    expect(res.status).toBe(201);

    const { rows: orgs } = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM organizations');
    expect(orgs[0]?.n).toBe(1);

    const login = await request(app).post('/api/v1/auth/login').send({ email, password: 'a-perfectly-fine-password' });
    expect(login.body.organization.id).toBe(alice.orgId);
    expect(login.body.role).toBe('VIEWER');
  });

  it('rolls the user back when the email does not match the invitation', async () => {
    const { token } = await invite('invited@example.com');
    const email = uniqueEmail('other');
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'a-perfectly-fine-password', inviteToken: token });
    expect(res.status).toBe(403);

    const { rows } = await pool.query('SELECT 1 FROM users WHERE email = $1', [email]);
    expect(rows).toHaveLength(0);
  });

  it('still requires an organization name without an invitation', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail('x'), password: 'a-perfectly-fine-password' });
    expect(res.status).toBe(400);
  });
});
