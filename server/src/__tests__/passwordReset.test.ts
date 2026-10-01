import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { closePool, pool } from '../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from './helpers/factories.js';
import { latestEmailToken } from './helpers/email.js';

/**
 * Forgot / reset password (2026-09-29), end to end through HTTP and a real
 * database. Since Phase 38b the link is emailed through the outbox, so these
 * tests read the raw token from the outbox row — the only place it exists,
 * since the token table stores a hash.
 */

const app = createApp();
const FORGOT = '/api/v1/auth/forgot-password';
const RESET = '/api/v1/auth/reset-password';

beforeEach(resetTables);
afterEach(() => vi.restoreAllMocks());
afterAll(closePool);

/** Requests a reset for `email` and returns the token from the emailed link (Phase 38b: the outbox). */
async function requestToken(email: string): Promise<string> {
  const res = await request(app).post(FORGOT).send({ email });
  expect(res.status).toBe(202);
  return latestEmailToken(email, 'password_reset');
}

describe('POST /auth/forgot-password', () => {
  it('answers 202 with the same body whether or not the account exists', async () => {
    const user = await createUserWithOrg({ label: 'reset-known' });
    const known = await request(app).post(FORGOT).send({ email: user.email });
    const unknown = await request(app).post(FORGOT).send({ email: 'nobody-here@example.com' });

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(unknown.body).toEqual(known.body);

    const { rows } = await pool.query('SELECT user_id FROM password_reset_tokens');
    expect(rows).toHaveLength(1);
  });

  it('stores only a hash, and a second request leaves just the newest token', async () => {
    const user = await createUserWithOrg({ label: 'reset-hash' });
    const first = await requestToken(user.email);
    const second = await requestToken(user.email);

    const { rows } = await pool.query<{ token_hash: string }>('SELECT token_hash FROM password_reset_tokens WHERE user_id = $1', [user.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toBe(second);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);

    // The superseded link no longer works.
    const stale = await request(app).post(RESET).send({ token: first, password: 'a-brand-new-password' });
    expect(stale.status).toBe(400);
  });

  it('matches the email case-insensitively, like login', async () => {
    const user = await createUserWithOrg({ label: 'reset-case' });
    await request(app).post(FORGOT).send({ email: user.email.toUpperCase() });
    const { rows } = await pool.query('SELECT 1 FROM password_reset_tokens WHERE user_id = $1', [user.id]);
    expect(rows).toHaveLength(1);
  });
});

describe('POST /auth/reset-password', () => {
  it('sets the new password and signs the user out of every existing session', async () => {
    const user = await createUserWithOrg({ label: 'reset-ok' });
    const agent = await loginAgent(app, user);
    const token = await requestToken(user.email);

    const res = await request(app).post(RESET).send({ token, password: 'a-brand-new-password' });
    expect(res.status).toBe(200);

    const oldLogin = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: user.password });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: 'a-brand-new-password' });
    expect(newLogin.status).toBe(200);

    // The session opened before the reset can no longer be refreshed.
    const refreshed = await agent.post('/api/v1/auth/refresh');
    expect(refreshed.status).toBe(401);
  });

  it('is single-use', async () => {
    const user = await createUserWithOrg({ label: 'reset-once' });
    const token = await requestToken(user.email);

    expect((await request(app).post(RESET).send({ token, password: 'first-new-password' })).status).toBe(200);
    const again = await request(app).post(RESET).send({ token, password: 'second-new-password' });
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/invalid or has already been used/);
  });

  it('refuses an expired token and deletes it, leaving the password unchanged', async () => {
    const user = await createUserWithOrg({ label: 'reset-expired' });
    const token = await requestToken(user.email);
    await pool.query(
      `UPDATE password_reset_tokens SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE user_id = $1`,
      [user.id],
    );

    const res = await request(app).post(RESET).send({ token, password: 'a-brand-new-password' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expired/);

    const { rows } = await pool.query('SELECT 1 FROM password_reset_tokens WHERE user_id = $1', [user.id]);
    expect(rows).toHaveLength(0);
    const login = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: user.password });
    expect(login.status).toBe(200);
  });

  it('rejects a weak password without spending the token', async () => {
    const user = await createUserWithOrg({ label: 'reset-weak' });
    const token = await requestToken(user.email);

    const weak = await request(app).post(RESET).send({ token, password: 'short' });
    expect(weak.status).toBe(400);
    const ok = await request(app).post(RESET).send({ token, password: 'a-brand-new-password' });
    expect(ok.status).toBe(200);
  });

  it("resetting one user's password touches no other account (isolation)", async () => {
    const userA = await createUserWithOrg({ label: 'reset-a' });
    const userB = await createUserWithOrg({ label: 'reset-b' });
    const agentB = await loginAgent(app, userB);
    const tokenA = await requestToken(userA.email);

    await request(app).post(RESET).send({ token: tokenA, password: 'a-brand-new-password' });

    const loginB = await request(app).post('/api/v1/auth/login').send({ email: userB.email, password: userB.password });
    expect(loginB.status).toBe(200);
    expect((await agentB.post('/api/v1/auth/refresh')).status).toBe(200);
  });
});

describe('password_reset_tokens constraints', () => {
  it('refuses a row that expires before it was created, and a duplicate hash', async () => {
    const user = await createUserWithOrg({ label: 'reset-constraints' });
    await expect(
      pool.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, 'h1', now() - interval '1 minute')`, [user.id]),
    ).rejects.toThrow(/ck_password_reset_tokens_expires_after_created/);

    await pool.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, 'h2', now() + interval '1 hour')`, [user.id]);
    await expect(
      pool.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, 'h2', now() + interval '1 hour')`, [user.id]),
    ).rejects.toThrow(/ux_password_reset_tokens_token_hash/);
  });

  it("deleting a user deletes their reset tokens (ON DELETE CASCADE)", async () => {
    const user = await createUserWithOrg({ label: 'reset-cascade' });
    await requestToken(user.email);
    await pool.query('DELETE FROM organization_members WHERE user_id = $1', [user.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
    const { rows } = await pool.query('SELECT 1 FROM password_reset_tokens WHERE user_id = $1', [user.id]);
    expect(rows).toHaveLength(0);
  });
});
