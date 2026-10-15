import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { logger } from '../utils/logger.js';
import apiRouter from '../routes/index.js';
import { SECRET_PATH_PREFIXES, redactPath } from '../middleware/requestContext.js';

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

  it('redacts an invitation token', async () => {
    const spy = vi.spyOn(logger, 'info');
    const token = 'invite-token-' + 'z'.repeat(30);
    await request(app).get(`/api/v1/auth/invitations/${token}`);
    const paths = loggedPaths(spy);
    expect(paths).toContain('/api/v1/auth/invitations/[redacted]');
    expect(JSON.stringify(spy.mock.calls)).not.toContain(token);
  });

  it('redacts a statement token', async () => {
    const spy = vi.spyOn(logger, 'info');
    const token = 'stmt-token-' + 'w'.repeat(30);
    await request(app).get(`/api/v1/public/statements/${token}`);
    const paths = loggedPaths(spy);
    expect(paths).toContain('/api/v1/public/statements/[redacted]');
    expect(JSON.stringify(spy.mock.calls)).not.toContain(token);
  });
});

describe('redactPath', () => {
  it.each([
    ['/api/v1/public/quotes/abc/pdf', '/api/v1/public/quotes/[redacted]/pdf'],
    ['/api/v1/public/quotes/abc', '/api/v1/public/quotes/[redacted]'],
    [
      '/api/v1/public/statements/abc/payments/pi_1/confirm',
      '/api/v1/public/statements/[redacted]/payments/pi_1/confirm',
    ],
    ['/api/v1/auth/invitations/abc/accept', '/api/v1/auth/invitations/[redacted]/accept'],
    ['/api/v1/public/inbound-mail/brevo/s3cret', '/api/v1/public/inbound-mail/brevo/[redacted]'],
    ['/API/V1/PUBLIC/QUOTES/abc', '/API/V1/PUBLIC/QUOTES/[redacted]'],
    ['/api/v1/public/quotes/', '/api/v1/public/quotes/'],
    [
      '/api/v1/invoices/123e4567-e89b-12d3-a456-426614174000',
      '/api/v1/invoices/123e4567-e89b-12d3-a456-426614174000',
    ],
    ['/api/v1/auth/login', '/api/v1/auth/login'],
  ])('%s -> %s', (input, expected) => {
    expect(redactPath(input)).toBe(expected);
  });
});

interface RouteLayer {
  route?: { path: string };
  handle: unknown;
}

function collectPaths(router: unknown, out: string[]): void {
  const stack = (router as { stack?: RouteLayer[] }).stack ?? [];
  for (const layer of stack) {
    if (layer.route !== undefined) {
      out.push(layer.route.path);
    } else if (typeof layer.handle === 'function' && 'stack' in (layer.handle as object)) {
      collectPaths(layer.handle, out);
    }
  }
}

// Adding a route with a `:token`/`:secret` param changes this count. Add the
// route's mount to SECRET_PATH_PREFIXES in middleware/requestContext.ts, add a
// row to the redactPath table above, then update the count.
const CREDENTIAL_ROUTE_COUNT = 13;

describe('credential routes', () => {
  it('every :token / :secret route is covered — update SECRET_PATH_PREFIXES when this count changes', () => {
    const paths: string[] = [];
    collectPaths(apiRouter, paths);
    const credential = paths.filter((path) => path.includes(':token') || path.includes(':secret'));
    expect(credential).toHaveLength(CREDENTIAL_ROUTE_COUNT);
    expect(SECRET_PATH_PREFIXES).toHaveLength(4);
  });
});
