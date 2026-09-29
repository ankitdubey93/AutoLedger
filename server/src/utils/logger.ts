import { pino } from 'pino';
import { env } from '../config/env.js';
import { getRequestContext } from './requestContext.js';

/**
 * The server's one logger: newline-delimited JSON on stdout, which is what a
 * container platform or log shipper expects to collect. Pretty-printing is
 * left to the reader (`| npx pino-pretty` locally) rather than installed.
 *
 * `mixin` stamps every line with the current request's id, user and org from
 * the AsyncLocalStorage context — so a log line written deep inside a service
 * can still be tied back to the request that caused it, with nothing threaded
 * through function signatures. Outside a request (the worker, startup) the
 * context is absent and the fields are simply omitted.
 *
 * Never log a token, a password, or a decoded JWT payload (rule 11); `redact`
 * is a backstop for the obvious field names, not a licence to log objects
 * wholesale.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'autoledger-server' },
  mixin() {
    const context = getRequestContext();
    if (context === undefined) return {};
    return {
      ...(context.requestId !== null ? { requestId: context.requestId } : {}),
      ...(context.userId !== null ? { userId: context.userId } : {}),
      ...(context.orgId !== null ? { orgId: context.orgId } : {}),
    };
  },
  redact: {
    paths: ['password', 'token', 'accessToken', 'refreshToken', '*.password', '*.token', 'req.headers.cookie', 'req.headers.authorization'],
    censor: '[redacted]',
  },
});
