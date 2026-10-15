import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { runWithRequestContext, type RequestContext } from '../utils/requestContext.js';
import { logger } from '../utils/logger.js';

/**
 * An incoming `X-Request-Id` (set by a proxy or a calling service) is kept so
 * one id follows a request across systems — but only if it looks like an id.
 * It is written into every log line, so an arbitrary client-supplied string
 * (newlines, a megabyte of text) must not be.
 */
const INCOMING_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Route params whose value is a credential carried in the URL path — an
 * invitation/quote/statement link token, or the inbound-mail webhook secret.
 * Their value is replaced in the logged path (rule 11).
 */
const SECRET_PARAMS = ['token', 'secret'] as const;

function redactPath(path: string, params: Record<string, unknown> | undefined): string {
  if (params === undefined) return path;
  let result = path;
  for (const name of SECRET_PARAMS) {
    const value = params[name];
    if (typeof value !== 'string' || value === '') continue;
    // Params are URL-decoded; the logged path is still encoded. Match both.
    for (const form of new Set([value, encodeURIComponent(value)])) {
      result = result
        .split('/')
        .map((segment) => (segment === form ? '[redacted]' : segment))
        .join('/');
    }
  }
  return result;
}

/**
 * Opens the per-request `AsyncLocalStorage` context that Phase 5's audit
 * trail reads the actor and IP from. Mounted first in `app.ts`, before
 * `cors` — even a request that never reaches a route (a CORS rejection, a
 * 404) is still a request, and every code path that could touch the
 * database must find a context waiting.
 *
 * `req.ip` is the socket peer address unless `app.set('trust proxy', ...)`
 * is configured, which this app deliberately does not do — behind a reverse
 * proxy every audit row would otherwise record the proxy's own address. That
 * is a known, stated limitation (docs/architecture.md), not something to
 * work around by reading `X-Forwarded-For`: a client-supplied header must
 * never reach the audit trail, since it would let any caller forge the IP
 * their own actions are attributed to.
 *
 * `userId`/`orgId` start null here — `authenticate` fills them in once the
 * access token verifies, on this same context object.
 */
export const attachRequestContext: RequestHandler = (req, res, next) => {
  const incoming = req.get('x-request-id');
  const context: RequestContext = {
    requestId: incoming !== undefined && INCOMING_REQUEST_ID.test(incoming) ? incoming : randomUUID(),
    ip: typeof req.ip === 'string' && req.ip !== '' ? req.ip.slice(0, 45) : null,
    userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
    userId: null,
    orgId: null,
  };
  res.setHeader('X-Request-Id', context.requestId ?? '');

  // One line per completed request. Built from `context` directly, not the
  // AsyncLocalStorage mixin: a 'finish' listener runs wherever the socket
  // emits it, which is not guaranteed to be inside this request's context.
  // `originalUrl` without the query string — a query can carry search terms
  // or a reset token, neither of which belongs in a log.
  const startedAt = process.hrtime.bigint();
  // Express reassigns `req.params` for every matched layer and restores the
  // outer value as it unwinds, so neither a handler's nor the error
  // middleware's view survives to 'finish'. An accessor on `req` sees each
  // assignment and keeps the credential params.
  const routeParams: Record<string, unknown> = {};
  let currentParams: unknown = req.params;
  Object.defineProperty(req, 'params', {
    configurable: true,
    enumerable: true,
    get: () => currentParams,
    set: (value: unknown) => {
      currentParams = value;
      if (typeof value !== 'object' || value === null) return;
      for (const name of SECRET_PARAMS) {
        const v = (value as Record<string, unknown>)[name];
        if (typeof v === 'string' && v !== '') routeParams[name] = v;
      }
    },
  });
  res.on('finish', () => {
    logger.info(
      {
        requestId: context.requestId,
        userId: context.userId ?? undefined,
        orgId: context.orgId ?? undefined,
        method: req.method,
        path: redactPath(req.originalUrl.split('?')[0] ?? '', routeParams),
        status: res.statusCode,
        durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
      },
      'request completed',
    );
  });

  runWithRequestContext(context, next);
};
