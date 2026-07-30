import request from 'supertest';
import { createApp } from '../app.js';
import { closePool } from '../db/connect.js';

/**
 * Integration tier — requires the real PostgreSQL container
 * (`docker compose up -d postgres`). docs/testing.md: mocking the pool would
 * prove the route returns an object, not that the database is actually reachable
 * with these credentials, which is the only claim this endpoint makes.
 */
describe('GET /api/v1/health', () => {
  const app = createApp();

  afterAll(async () => {
    // The pool keeps the event loop alive; without this Vitest hangs on exit.
    await closePool();
  });

  it('reports ok with a live database round trip', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      status: 'ok',
      service: 'autoledger-server',
      apiVersion: 'v1',
      db: { connected: true },
    });
    expect(typeof res.body.db.latencyMs).toBe('number');
    expect(typeof res.body.uptimeSeconds).toBe('number');
  });
});
