import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { logger } from '../utils/logger.js';

/**
 * Rule 11 — a credential carried in a URL path must never reach the access
 * log. The `request completed` line replaces the value of any matched route
 * param named `token` or `secret`.
 */

const app = createApp();

function loggedPaths(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .filter((call) => call[1] === 'request completed')
    .map((call) => (call[0] as { path: string }).path);
}

describe('request log redaction', () => {
  afterEach(() => vi.restoreAllMocks());

  it('redacts the inbound-mail webhook secret', async () => {
    const spy = vi.spyOn(logger, 'info');
    const secret = 'webhook-secret-' + 'x'.repeat(30);
    await request(app).post(`/api/v1/public/inbound-mail/brevo/${secret}`).send({ items: [] });
    const paths = loggedPaths(spy);
    expect(paths).toContain('/api/v1/public/inbound-mail/brevo/[redacted]');
    expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
  });

  it('redacts a public quote token but keeps other segments', async () => {
    const spy = vi.spyOn(logger, 'info');
    const token = 'quote-token-' + 'y'.repeat(30);
    await request(app).get(`/api/v1/public/quotes/${token}/pdf?x=1`);
    const paths = loggedPaths(spy);
    expect(paths).toContain('/api/v1/public/quotes/[redacted]/pdf');
    expect(JSON.stringify(spy.mock.calls)).not.toContain(token);
  });
});
