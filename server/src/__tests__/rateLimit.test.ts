import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createAuthLimiter } from '../middleware/rateLimit.js';
import { errorHandler } from '../middleware/errorHandler.js';

/**
 * Unit tier — no database.
 *
 * The limiter is mounted on a throwaway app with a deliberately tiny limit,
 * rather than on the real one: lowering the ambient limit would make every
 * other integration test flaky, since they all log in repeatedly from 127.0.0.1.
 */

function appWithLimiter(max: number) {
  const app = express();
  app.use(express.json());
  app.post('/login', createAuthLimiter({ windowMs: 60_000, max }), (req, res) => {
    // Mirrors the real login: a bad password is a 401, a good one a 200.
    if (req.body?.password === 'correct') {
      res.json({ success: true });
      return;
    }
    res.status(401).json({ success: false, error: 'Invalid credentials' });
  });
  app.use(errorHandler);
  return app;
}

describe('auth rate limiting', () => {
  it('allows attempts up to the limit, then returns 429', async () => {
    const app = appWithLimiter(3);
    const agent = request.agent(app);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const res = await agent.post('/login').send({ password: 'wrong' });
      expect(res.status).toBe(401);
    }

    const blocked = await agent.post('/login').send({ password: 'wrong' });
    expect(blocked.status).toBe(429);
  });

  it('formats the rejection with the API error envelope', async () => {
    const app = appWithLimiter(1);
    const agent = request.agent(app);

    await agent.post('/login').send({ password: 'wrong' });
    const blocked = await agent.post('/login').send({ password: 'wrong' });

    // Routed through errorHandler, not written by the library — every error in
    // this API has the same shape (docs/api.md).
    expect(blocked.body).toEqual({ success: false, error: 'Too many attempts. Try again later.' });
  });

  it('does not count successful logins against the limit', async () => {
    const app = appWithLimiter(2);
    const agent = request.agent(app);

    // Ten successful logins in a row must not exhaust anything: otherwise a
    // shared office IP would lock colleagues out of a working password.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await agent.post('/login').send({ password: 'correct' });
      expect(res.status).toBe(200);
    }

    // The budget for failures is still intact.
    expect((await agent.post('/login').send({ password: 'wrong' })).status).toBe(401);
  });

  it('advertises the standard RateLimit headers', async () => {
    const app = appWithLimiter(5);
    const res = await request(app).post('/login').send({ password: 'wrong' });

    expect(res.headers['ratelimit-limit'] ?? res.headers['ratelimit']).toBeDefined();
    // The deprecated X-RateLimit-* set is off.
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
  });
});
