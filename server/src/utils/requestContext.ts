import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request state that has to reach the database layer without being
 * threaded through every service and controller signature — currently just
 * the caller's identity and IP, for Phase 5's audit trail.
 *
 * The object is **mutable on purpose**. `attachRequestContext` runs before
 * `authenticate`, so the caller's identity is not known yet when the context
 * is created; `authenticate` fills in `userId`/`orgId` on this same object
 * rather than opening a second context, so every later `await` in the
 * request sees the identity once it exists.
 *
 * `AsyncLocalStorage` is `node:async_hooks`, part of the Node runtime — this
 * introduces no new dependency (guardrails rule 14).
 */
export interface RequestContext {
  /** Express's resolved client IP, truncated to fit `audit_logs.client_ip`, or null. */
  ip: string | null;
  /** Set by `authenticate` once the access token verifies. Null before that, and forever on an unauthenticated route. */
  userId: string | null;
  orgId: string | null;
}

export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return requestContextStorage.run(context, fn);
}
