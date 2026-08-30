import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { pool, closePool } from '../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables, uniqueEmail } from './helpers/factories.js';

/**
 * The auth flow end to end, through real HTTP against a real database.
 * Nothing here is mocked — the point is to exercise the cookies, the
 * transaction and the rotation, which a mocked pool would not.
 */

const app = createApp();

/** curl and supertest both surface Set-Cookie as an array of raw header strings. */
function cookieNames(res: request.Response): string[] {
  const raw: unknown = res.headers['set-cookie'];
  if (!Array.isArray(raw)) return [];
  return raw.map((c: string) => c.split('=')[0] ?? '');
}

beforeEach(resetTables);
afterAll(closePool);

describe('POST /auth/register', () => {
  it('creates the user, the organization and an OWNER membership together', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'Ada',
      email: 'Ada@Example.com',
      password: 'a-perfectly-fine-password',
      organizationName: 'Analytical Engines',
    });

    expect(res.status).toBe(201);
    // Stored lowercase (guardrails rule 9), so login is case-insensitive later.
    expect(res.body.user.email).toBe('ada@example.com');
    expect(res.body.user).not.toHaveProperty('password');

    const members = await pool.query<{ role: string; slug: string }>(
      `SELECT m.role, o.slug FROM organization_members m
         JOIN organizations o ON o.id = m.org_id
        WHERE m.user_id = $1`,
      [res.body.user.id],
    );
    expect(members.rows[0]?.role).toBe('OWNER');
    expect(members.rows[0]?.slug).toBe('analytical-engines');
  });

  it('does not log you in', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      email: uniqueEmail(),
      password: 'a-perfectly-fine-password',
      organizationName: 'No Session Co',
    });

    expect(cookieNames(res)).toEqual([]);
  });

  it('rejects a duplicate email regardless of case, and creates nothing', async () => {
    const email = uniqueEmail('dupe');
    await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'a-perfectly-fine-password', organizationName: 'First' });

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: email.toUpperCase(),
        password: 'a-perfectly-fine-password',
        organizationName: 'Second',
      });

    expect(res.status).toBe(409);

    // The transaction rolled back, so the second organization must not exist.
    // A leaked org here would mean the user INSERT and the org INSERT were not
    // actually atomic.
    const orgs = await pool.query("SELECT 1 FROM organizations WHERE name = 'Second'");
    expect(orgs.rowCount).toBe(0);
  });

  it('gives colliding organization names distinct slugs', async () => {
    for (const label of ['a', 'b']) {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: uniqueEmail(label),
          password: 'a-perfectly-fine-password',
          organizationName: 'Acme',
        });
      expect(res.status).toBe(201);
    }

    const { rows } = await pool.query<{ slug: string }>(
      "SELECT slug FROM organizations WHERE name = 'Acme' ORDER BY created_at",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.slug).toBe('acme');
    // Second one is suffixed rather than rejected.
    expect(rows[1]?.slug).toMatch(/^acme-[0-9a-f]{6}$/);
  });

  it.each([
    ['short password', { password: 'short' }],
    ['missing organizationName', { organizationName: undefined }],
    ['malformed email', { email: 'not-an-email' }],
  ])('rejects %s with 400', async (_label, override) => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: uniqueEmail(),
        password: 'a-perfectly-fine-password',
        organizationName: 'Valid Co',
        ...override,
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects a password over 72 bytes rather than silently truncating it', async () => {
    // bcrypt ignores everything past 72 bytes, so accepting this would make
    // two different passwords interchangeable at login.
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: uniqueEmail(),
        password: 'x'.repeat(73),
        organizationName: 'Long Co',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/72 bytes/);
  });
});

describe('POST /auth/login', () => {
  it('sets both cookies httpOnly, and scopes the refresh cookie to /auth', async () => {
    const user = await createUserWithOrg();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password });

    expect(res.status).toBe(200);

    const cookies = res.headers['set-cookie'] as unknown as string[];
    const access = cookies.find((c) => c.startsWith('autoledger_at='));
    const refresh = cookies.find((c) => c.startsWith('autoledger_rt='));

    // httpOnly is what keeps an XSS payload from reading the token.
    expect(access).toMatch(/HttpOnly/);
    expect(refresh).toMatch(/HttpOnly/);
    expect(access).toMatch(/SameSite=Lax/);
    // Not sent with ordinary API calls — only the auth routes need it.
    expect(refresh).toMatch(/Path=\/api\/v1\/auth/);
  });

  it('accepts a different email case than was registered', async () => {
    const user = await createUserWithOrg();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email.toUpperCase(), password: user.password });

    // The prior build stored lowercase but compared exactly, locking users out.
    expect(res.status).toBe(200);
  });

  it.each([
    ['wrong password', (u: { email: string }) => ({ email: u.email, password: 'wrong-password' })],
    ['unknown email', () => ({ email: uniqueEmail('ghost'), password: 'a-perfectly-fine-password' })],
  ])('returns an identical 401 for %s', async (_label, build) => {
    const user = await createUserWithOrg();
    const res = await request(app).post('/api/v1/auth/login').send(build(user));

    expect(res.status).toBe(401);
    // Same message either way: a different one would confirm which emails
    // have accounts.
    expect(res.body.error).toBe('Invalid email or password');
  });
});

describe('GET /auth/check', () => {
  it('returns the session for a logged-in caller', async () => {
    const user = await createUserWithOrg();
    const agent = await loginAgent(app, user);

    const res = await agent.get('/api/v1/auth/check');

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(user.email);
    expect(res.body.role).toBe('OWNER');
    expect(res.body.memberships).toHaveLength(1);
    // The client cannot read the httpOnly cookie, so the server states this.
    expect(Date.parse(res.body.accessTokenExpiresAt)).toBeGreaterThan(Date.now());
  });

  it('401s without a token', async () => {
    const res = await request(app).get('/api/v1/auth/check');
    expect(res.status).toBe(401);
  });

  it('401s on a token signed with the wrong key', async () => {
    const res = await request(app)
      .get('/api/v1/auth/check')
      .set('Cookie', ['autoledger_at=not.a.real.token']);
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/refresh', () => {
  it('rotates the refresh token and keeps the session alive', async () => {
    const user = await createUserWithOrg();
    const agent = await loginAgent(app, user);

    const res = await agent.post('/api/v1/auth/refresh');

    expect(res.status).toBe(200);
    expect(cookieNames(res).sort()).toEqual(['autoledger_at', 'autoledger_rt']);
    // Exactly one live session row — the old one was consumed, not accumulated.
    const { rowCount } = await pool.query('SELECT 1 FROM refresh_tokens WHERE user_id = $1', [
      user.id,
    ]);
    expect(rowCount).toBe(1);
    expect((await agent.get('/api/v1/auth/check')).status).toBe(200);
  });

  it('401s with no refresh cookie', async () => {
    const res = await request(app).post('/api/v1/auth/refresh');
    expect(res.status).toBe(401);
  });

  it('detects reuse of an already-rotated token and drops the whole family', async () => {
    const user = await createUserWithOrg();
    const agent = await loginAgent(app, user);

    // Capture the cookie before rotation, the way a stolen token would be.
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password });
    const stolen = (login.headers['set-cookie'] as unknown as string[])
      .find((c) => c.startsWith('autoledger_rt='))
      ?.split(';')[0];
    if (stolen === undefined) throw new Error('no refresh cookie issued');

    // The legitimate holder rotates first.
    const first = await request(app).post('/api/v1/auth/refresh').set('Cookie', [stolen]);
    expect(first.status).toBe(200);

    // Replaying the spent token is the signal that it leaked.
    const replay = await request(app).post('/api/v1/auth/refresh').set('Cookie', [stolen]);
    expect(replay.status).toBe(401);
    expect(replay.body.error).toMatch(/already been used/);

    // Family invalidation: every session for this user is dropped, including
    // the agent's unrelated one, because we cannot tell attacker from victim.
    const { rowCount } = await pool.query('SELECT 1 FROM refresh_tokens WHERE user_id = $1', [
      user.id,
    ]);
    expect(rowCount).toBe(0);
    expect((await agent.post('/api/v1/auth/refresh')).status).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('deletes the refresh row and clears both cookies', async () => {
    const user = await createUserWithOrg();
    const agent = await loginAgent(app, user);

    const res = await agent.post('/api/v1/auth/logout');
    expect(res.status).toBe(200);

    // clearCookie only matches when path/sameSite/secure/httpOnly match the
    // originals — a mismatch here means logout silently leaves the cookie.
    const cleared = res.headers['set-cookie'] as unknown as string[];
    expect(cleared.find((c) => c.startsWith('autoledger_rt='))).toMatch(/Path=\/api\/v1\/auth/);

    const { rowCount } = await pool.query('SELECT 1 FROM refresh_tokens WHERE user_id = $1', [
      user.id,
    ]);
    expect(rowCount).toBe(0);
    expect((await agent.post('/api/v1/auth/refresh')).status).toBe(401);
  });

  it('succeeds when nobody is logged in', async () => {
    // The client must always be able to reach a clean state.
    expect((await request(app).post('/api/v1/auth/logout')).status).toBe(200);
  });
});
