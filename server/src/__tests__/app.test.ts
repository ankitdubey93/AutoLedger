import request from 'supertest';
import { createApp } from '../app.js';

/**
 * Unit tier — no database. Proves the middleware wiring in app.ts: that an
 * unmatched route reaches notFoundHandler, and that the error handler is
 * registered with the arity Express needs to recognise it as one.
 */
describe('app wiring', () => {
  const app = createApp();

  it('answers a 404 for an unknown route in the documented error shape', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: 'Route not found: GET /api/v1/does-not-exist',
    });
  });

  it('404s an unversioned path, so nothing is reachable outside /api/v1', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  // Phase 33 mounts accounting at the root of /api/v1. Its routers claim only
  // their own paths, so an unknown path must still fall through to the 404
  // handler, never to an auth check that would answer 401 instead.
  it.each([
    ['an unknown path under the root-mounted accounting routes', '/api/v1/nope/deeper'],
    ['the retired /ledger-core prefix', '/api/v1/ledger-core/accounts'],
    ['the retired /stock prefix', '/api/v1/stock/items'],
    ['the retired /ap-flow prefix', '/api/v1/ap-flow/documents'],
    ['the retired app registry', '/api/v1/apps'],
  ])('404s %s', async (_label, path) => {
    const res = await request(app).get(path);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('does not disclose the server framework', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');

    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
