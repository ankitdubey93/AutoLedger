import type { RequestHandler } from 'express';
import { runWithRequestContext, type RequestContext } from '../utils/requestContext.js';

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
export const attachRequestContext: RequestHandler = (req, _res, next) => {
  const context: RequestContext = {
    ip: typeof req.ip === 'string' && req.ip !== '' ? req.ip.slice(0, 45) : null,
    userId: null,
    orgId: null,
  };

  runWithRequestContext(context, next);
};
