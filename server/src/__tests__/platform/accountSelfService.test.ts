import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Phase 38a — user settings: profile, change password, and the sessions
 * list. Everything here is scoped to the caller's own identity, so the
 * isolation cases are cross-*user*: another user's session id is a 404.
 */

const app = createApp();

let alice: SeededUser;

beforeEach(async () => {
  await resetTables();
  alice = await createUserWithOrg({ label: 'alice', orgName: 'Alpha Ltd' });
});

afterAll(closePool);

describe('PATCH /auth/me', () => {
  it('updates the display name and /auth/check reflects it', async () => {
    const agent = await loginAgent(app, alice);
    const res = await agent.patch('/api/v1/auth/me').send({ name: 'Alice Liddell' });
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('Alice Liddell');
    expect((await agent.get('/api/v1/auth/check')).body.user.name).toBe('Alice Liddell');
  });
});

describe('POST /auth/change-password', () => {
  it('refuses a wrong current password with 400, not 401', async () => {
    const agent = await loginAgent(app, alice);
    const res = await agent
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: 'not-my-password', newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(400);
  });

  it('changes the password, signs out other sessions and keeps this one', async () => {
    const here = await loginAgent(app, alice);
    const elsewhere = await loginAgent(app, alice);

    const res = await here
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: alice.password, newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(200);
    expect(res.body.signedOutSessions).toBe(1);

    // This browser keeps working through a refresh; the other one is gone.
    expect((await here.post('/api/v1/auth/refresh')).status).toBe(200);
    expect((await elsewhere.post('/api/v1/auth/refresh')).status).toBe(401);

    const oldLogin = await request(app).post('/api/v1/auth/login').send({ email: alice.email, password: alice.password });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: alice.email, password: 'a-brand-new-password' });
    expect(newLogin.status).toBe(200);
  });

  it('applies the registration password rules to the new password', async () => {
    const agent = await loginAgent(app, alice);
    const res = await agent.post('/api/v1/auth/change-password').send({ currentPassword: alice.password, newPassword: 'short' });
    expect(res.status).toBe(400);
  });
});

describe('sessions', () => {
  it('lists each signed-in browser once, marks the current one, and keeps the id across rotation', async () => {
    const here = await loginAgent(app, alice);
    await loginAgent(app, alice);

    const before = await here.get('/api/v1/auth/sessions');
    expect(before.body.sessions).toHaveLength(2);
    const current = before.body.sessions.find((s: { current: boolean }) => s.current);
    expect(current).toBeDefined();
    expect(current.organizationName).toBe('Alpha Ltd');

    // A refresh and an org creation both rotate the refresh row; the session
    // id and its start time survive both.
    await here.post('/api/v1/auth/refresh').expect(200);
    await here.post('/api/v1/auth/organizations').send({ name: 'Beta Ltd' }).expect(201);
    const after = await here.get('/api/v1/auth/sessions');
    expect(after.body.sessions).toHaveLength(2);
    const stillCurrent = after.body.sessions.find((s: { current: boolean }) => s.current);
    expect(stillCurrent.id).toBe(current.id);
    expect(stillCurrent.startedAt).toBe(current.startedAt);
    expect(stillCurrent.organizationName).toBe('Beta Ltd');
  });

  it('revokes one other session, and refuses the current one', async () => {
    const here = await loginAgent(app, alice);
    const elsewhere = await loginAgent(app, alice);
    const { sessions } = (await here.get('/api/v1/auth/sessions')).body as {
      sessions: Array<{ id: string; current: boolean }>;
    };
    const mine = sessions.find((s) => s.current);
    const other = sessions.find((s) => !s.current);
    if (mine === undefined || other === undefined) throw new Error('fixture: expected two sessions');

    expect((await here.delete(`/api/v1/auth/sessions/${mine.id}`)).status).toBe(422);
    expect((await here.delete(`/api/v1/auth/sessions/${other.id}`)).status).toBe(200);
    expect((await elsewhere.post('/api/v1/auth/refresh')).status).toBe(401);
    expect((await here.post('/api/v1/auth/refresh')).status).toBe(200);
  });

  it('a revoked browser cannot use its still-valid access token to mint a new session', async () => {
    const here = await loginAgent(app, alice);
    const elsewhere = await loginAgent(app, alice);
    await here.post('/api/v1/auth/sessions/revoke-others').expect(200);

    // `elsewhere` still holds an unexpired access token (up to 15 minutes);
    // the session-moving routes retire its refresh row and must refuse.
    const res = await elsewhere.post('/api/v1/auth/organizations').send({ name: 'Sneaky Ltd' });
    expect(res.status).toBe(401);
    const { rows } = await pool.query("SELECT 1 FROM organizations WHERE name = 'Sneaky Ltd'");
    expect(rows).toHaveLength(0);
    expect((await here.get('/api/v1/auth/sessions')).body.sessions).toHaveLength(1);
  });

  it('signs out every other session at once', async () => {
    const here = await loginAgent(app, alice);
    await loginAgent(app, alice);
    await loginAgent(app, alice);
    const res = await here.post('/api/v1/auth/sessions/revoke-others');
    expect(res.body.signedOutSessions).toBe(2);
    expect((await here.get('/api/v1/auth/sessions')).body.sessions).toHaveLength(1);
  });

  it("never lists or revokes another user's session (cross-user isolation)", async () => {
    const bob = await createUserWithOrg({ label: 'bob' });
    const bobAgent = await loginAgent(app, bob);
    const bobSession = (await bobAgent.get('/api/v1/auth/sessions')).body.sessions[0] as { id: string };

    const aliceAgent = await loginAgent(app, alice);
    const list = await aliceAgent.get('/api/v1/auth/sessions');
    expect(list.text).not.toContain(bobSession.id);
    expect((await aliceAgent.delete(`/api/v1/auth/sessions/${bobSession.id}`)).status).toBe(404);

    const { rows } = await pool.query('SELECT 1 FROM refresh_tokens WHERE session_id = $1', [bobSession.id]);
    expect(rows).toHaveLength(1);
  });

  it('records the user agent the browser sent', async () => {
    const agent = request.agent(app);
    await agent
      .post('/api/v1/auth/login')
      .set('User-Agent', 'TestBrowser/1.0')
      .send({ email: alice.email, password: alice.password })
      .expect(200);
    const res = await agent.get('/api/v1/auth/sessions');
    expect(res.body.sessions[0].userAgent).toBe('TestBrowser/1.0');
  });
});
