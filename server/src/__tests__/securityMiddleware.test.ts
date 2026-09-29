import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { closePool } from '../db/connect.js';
import { env } from '../config/env.js';

/**
 * The 2026-09-29 hardening: helmet's headers, request ids, and the Origin
 * check that refuses a state-changing request from a foreign page.
 */

const app = createApp();
const TRUSTED = new URL(env.FRONTEND_URL).origin;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

afterAll(closePool);

describe('security headers (helmet)', () => {
  it('sets nosniff, a no-referrer policy, and no X-Powered-By', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('request ids', () => {
  it('generates one per request and returns it', async () => {
    const a = await request(app).get('/api/v1/health');
    const b = await request(app).get('/api/v1/health');
    expect(a.headers['x-request-id']).toMatch(UUID);
    expect(b.headers['x-request-id']).not.toBe(a.headers['x-request-id']);
  });

  it('keeps a well-formed incoming id, and replaces a malformed one', async () => {
    const kept = await request(app).get('/api/v1/health').set('X-Request-Id', 'upstream-proxy-1234');
    expect(kept.headers['x-request-id']).toBe('upstream-proxy-1234');

    const replaced = await request(app).get('/api/v1/health').set('X-Request-Id', 'bad id\twith spaces');
    expect(replaced.headers['x-request-id']).toMatch(UUID);
  });

  it('is exposed to the browser client through CORS', async () => {
    const res = await request(app).get('/api/v1/health').set('Origin', TRUSTED);
    expect(res.headers['access-control-expose-headers']).toContain('X-Request-Id');
  });
});

describe('Origin check on state-changing requests', () => {
  it('refuses a POST from a foreign origin before it reaches the handler', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: 'a@example.com', password: 'whatever-password' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Cross-origin request refused' });
  });

  it("refuses Origin: null (sandboxed frames), since it is not the app's own", async () => {
    const res = await request(app).post('/api/v1/auth/logout').set('Origin', 'null');
    expect(res.status).toBe(403);
  });

  it('lets the trusted origin and origin-less callers through', async () => {
    const trusted = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', TRUSTED)
      .send({ email: 'nobody@example.com', password: 'whatever-password' });
    expect(trusted.status).toBe(401); // reached the handler

    const noOrigin = await request(app).post('/api/v1/auth/login').send({ email: 'nobody@example.com', password: 'whatever-password' });
    expect(noOrigin.status).toBe(401);
  });

  it('does not block safe methods from any origin — CORS governs reading those', async () => {
    const res = await request(app).get('/api/v1/health').set('Origin', 'https://evil.example');
    expect(res.status).toBe(200);
  });
});
