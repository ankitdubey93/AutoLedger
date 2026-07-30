/**
 * Values referenced from more than one layer. Kept out of `routes/` and
 * `env.ts` so nothing has to import a router to learn the API version — that
 * would make routes and controllers circularly dependent.
 */

/** URL path segment every route is mounted under. See docs/api.md. */
export const API_VERSION = 'v1';

export const API_BASE_PATH = `/api/${API_VERSION}`;

/** Rejecting oversized bodies before parsing is cheaper than after. */
export const JSON_BODY_LIMIT = '1mb';

/** Seconds to let in-flight requests finish before a forced exit. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;
