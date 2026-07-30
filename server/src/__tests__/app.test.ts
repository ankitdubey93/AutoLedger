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

  it('does not disclose the server framework', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');

    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
