import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { listMemberActivity, listMyLoginEvents } from '../../services/loginEventService.js';

/**
 * Phase 46d — sign-in history. Integration tier, real PostgreSQL. The write
 * paths are proven at the service seam; the two read routes are proven over
 * HTTP at the bottom of this file.
 */

const app = createApp();
const LOGIN = '/api/v1/auth/login';

interface EventRow {
  user_id: string | null;
  org_id: string | null;
  email: string;
  outcome: string;
}

async function events(): Promise<EventRow[]> {
  const { rows } = await pool.query<EventRow>(
    'SELECT user_id, org_id, email, outcome FROM login_events ORDER BY created_at, id',
  );
  return rows;
}

let alice: SeededUser;

beforeEach(async () => {
  await resetTables();
  alice = await createUserWithOrg({ label: 'alice' });
});

afterAll(async () => {
  await closePool();
});

describe('login events', () => {
  it('a successful login writes one SUCCESS with the opened org', async () => {
    await request(app).post(LOGIN).send({ email: alice.email, password: alice.password }).expect(200);
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: alice.id, org_id: alice.orgId, outcome: 'SUCCESS' });
  });

  it('a wrong password writes FAILED for that user, surviving the rollback', async () => {
    await request(app).post(LOGIN).send({ email: alice.email, password: 'definitely-wrong-one' }).expect(401);
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: alice.id, org_id: null, outcome: 'FAILED' });
  });

  it('an unknown email writes FAILED with a null user and a lowercased email', async () => {
    await request(app).post(LOGIN).send({ email: 'MiXeD@Example.com', password: 'whatever-password' }).expect(401);
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: null, email: 'mixed@example.com', outcome: 'FAILED' });
  });

  it('logout writes LOGOUT', async () => {
    const agent = await loginAgent(app, alice);
    await agent.post('/api/v1/auth/logout').expect(200);
    const outcomes = (await events()).map((e) => e.outcome);
    expect(outcomes).toEqual(['SUCCESS', 'LOGOUT']);
  });

  it("listMyLoginEvents returns only the caller's events", async () => {
    const bob = await createUserWithOrg({ label: 'bob' });
    await loginAgent(app, alice);
    await loginAgent(app, bob);
    const mine = await listMyLoginEvents(alice.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.outcome).toBe('SUCCESS');
  });

  it('listMemberActivity lists members with lastSignInAt set for the one who signed in', async () => {
    const bob = await createUserWithOrg({ label: 'bob' });
    await addMember(alice.orgId, bob.id, 'VIEWER');
    await loginAgent(app, alice);
    const rows = await listMemberActivity(alice.orgId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.userId === alice.id)?.lastSignInAt).not.toBeNull();
    expect(rows.find((r) => r.userId === bob.id)?.lastSignInAt).toBeNull();
  });

  it("another organization's sign-in is excluded from this org's lastSignInAt", async () => {
    const xavier = await createUserWithOrg({ label: 'xavier' });
    await addMember(alice.orgId, xavier.id, 'VIEWER');
    await loginAgent(app, xavier); // opens xavier's own org, not alice's
    const inAlice = await listMemberActivity(alice.orgId);
    expect(inAlice.find((r) => r.userId === xavier.id)?.lastSignInAt).toBeNull();
    const inOwn = await listMemberActivity(xavier.orgId);
    expect(inOwn.find((r) => r.userId === xavier.id)?.lastSignInAt).not.toBeNull();
  });

  it('is append-only: UPDATE is refused with 0A000', async () => {
    await request(app).post(LOGIN).send({ email: alice.email, password: alice.password }).expect(200);
    await expect(pool.query("UPDATE login_events SET outcome = 'SUCCESS'")).rejects.toMatchObject({
      code: '0A000',
    });
  });

  it('user deletion still cascades (no BEFORE DELETE trigger)', async () => {
    await request(app).post(LOGIN).send({ email: alice.email, password: alice.password }).expect(200);
    await pool.query('DELETE FROM organization_members WHERE user_id = $1', [alice.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [alice.id]);
    expect(await events()).toHaveLength(0);
  });
});

describe('login-event HTTP routes', () => {
  it('GET /auth/login-events returns the signed-in user\'s own events', async () => {
    const agent = await loginAgent(app, alice);
    const res = await agent.get('/api/v1/auth/login-events').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(1);
    expect(res.body.events[0]).toMatchObject({ outcome: 'SUCCESS' });
  });

  it('GET /organizations/members/activity is 200 for an OWNER and lists both members', async () => {
    const bob = await createUserWithOrg({ label: 'bob' });
    await addMember(alice.orgId, bob.id, 'VIEWER');
    const agent = await loginAgent(app, alice);
    const res = await agent.get('/api/v1/organizations/members/activity').expect(200);
    expect(res.body.count).toBe(2);
    const self = (res.body.members as { userId: string; lastSignInAt: string | null }[]).find(
      (m) => m.userId === alice.id,
    );
    expect(self?.lastSignInAt).not.toBeNull();
  });

  it('GET /organizations/members/activity is 403 for a VIEWER', async () => {
    const viewer = await createUserWithOrg({ label: 'viewer' });
    await addMember(alice.orgId, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, viewer);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: alice.orgId }).expect(200);
    await agent.get('/api/v1/organizations/members/activity').expect(403);
  });
});
