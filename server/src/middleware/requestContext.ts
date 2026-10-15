import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { runWithRequestContext, type RequestContext } from '../utils/requestContext.js';
import { logger } from '../utils/logger.js';
import { API_BASE_PATH } from '../config/constants.js';

/**
 * An incoming `X-Request-Id` (set by a proxy or a calling service) is kept so
 * one id follows a request across systems — but only if it looks like an id.
 * It is written into every log line, so an arbitrary client-supplied string
 * (newlines, a megabyte of text) must not be.
 */
const INCOMING_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Mount prefixes of routes whose next path segment is a credential —
 * invitation, quote and statement link tokens, and the inbound-mail
 * webhook secret. That one segment is logged as `[redacted]` (rule 11).
 * A new `:token`/`:secret` route must add its mount here; the guard test in
 * logRedaction.test.ts counts those routes and fails until it does.
 */
export const SECRET_PATH_PREFIXES: readonly string[] = Object.freeze([
  `${API_BASE_PATH}/auth/invitations/`,
  `${API_BASE_PATH}/public/quotes/`,
  `${API_BASE_PATH}/public/statements/`,
  `${API_BASE_PATH}/public/inbound-mail/brevo/`,
]);

/** `path` has no query string. Case-insensitive prefix match — Express routing is case-insensitive. */
export function redactPath(path: string): string {
  const lower = path.toLowerCase();
  for (const prefix of SECRET_PATH_PREFIXES) {
    if (!lower.startsWith(prefix.toLowerCase())) continue;
    const rest = path.slice(prefix.length);
    if (rest === '' || rest.startsWith('/')) return path;
    const i = rest.indexOf('/');
    return path.slice(0, prefix.length) + '[redacted]' + (i === -1 ? '' : rest.slice(i));
  }
  return path;
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
  res.on('finish', () => {
    logger.info(
      {
        requestId: context.requestId,
        userId: context.userId ?? undefined,
        orgId: context.orgId ?? undefined,
        method: req.method,
        path: redactPath(req.originalUrl.split('?')[0] ?? ''),
        status: res.statusCode,
        durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
      },
      'request completed',
    );
  });

  runWithRequestContext(context, next);
};
