import { env } from './env.js';

/**
 * Values referenced from more than one layer. Kept out of `routes/` and
 * `env.ts` so nothing has to import a router to learn the API version — that
 * would make routes and controllers circularly dependent.
 *
 * This file imports `env` but `env.ts` imports nothing from here, so the
 * dependency stays one-directional.
 */

/** URL path segment every route is mounted under. See docs/api.md. */
export const API_VERSION = 'v1';

export const API_BASE_PATH = `/api/${API_VERSION}`;

/** Rejecting oversized bodies before parsing is cheaper than after. */
export const JSON_BODY_LIMIT = '1mb';

/** Seconds to let in-flight requests finish before a forced exit. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/* ------------------------------------------------------------------ auth */

/**
 * `as const` is load-bearing. @types/jsonwebtoken types `SignOptions.expiresIn`
 * as `number | ms.StringValue`, a template-literal union — a value widened to
 * plain `string` fails to compile at the call site.
 */
export const ACCESS_TOKEN_TTL = '15m' as const;
export const REFRESH_TOKEN_TTL = '7d' as const;

/** The same 7 days in milliseconds, for the cookie maxAge and `expires_at`. */
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Cookies are keyed by name + domain + path and **ignore the port**, so every
 * app on localhost shares one jar. A generic `access_token` would be clobbered
 * by any other project you run; the prefix makes collisions impossible.
 */
export const ACCESS_COOKIE_NAME = 'autoledger_at';
export const REFRESH_COOKIE_NAME = 'autoledger_rt';

/**
 * The refresh cookie is scoped to the auth routes, so it is not attached to
 * every ordinary API call and cannot leak through a proxy log or a request
 * dump. Anything clearing it must pass this exact path — see utils/cookies.ts.
 */
export const REFRESH_COOKIE_PATH = `${API_BASE_PATH}/auth`;

/**
 * bcrypt work factor. Cost 12 is ~250ms per hash, which is the point in
 * production and intolerable across a test suite that hashes on every fixture,
 * so tests drop to the minimum. Not an env var: a misconfigured production
 * value would be a silent security regression.
 */
export const BCRYPT_COST = env.isTest ? 4 : 12;

/**
 * bcrypt truncates at 72 **bytes** and ignores the rest, so two long passwords
 * sharing a 72-byte prefix hash identically. Reject rather than silently
 * accept a password that isn't fully checked.
 */
export const MAX_PASSWORD_BYTES = 72;
export const MIN_PASSWORD_LENGTH = 8;

/** Arbitrary but fixed: the key every migration runner locks on. */
export const MIGRATIONS_ADVISORY_LOCK_KEY = 4815162342;
