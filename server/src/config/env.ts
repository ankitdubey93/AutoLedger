import 'dotenv/config';
import path from 'node:path';

/**
 * Environment parsing happens once, at import time, and fails loudly.
 *
 * Every missing variable is collected before throwing so a fresh checkout gets
 * one complete list instead of discovering them one restart at a time.
 * docs/development.md: the server must exit at boot if FRONTEND_URL is unset.
 */

const NODE_ENVS = ['development', 'test', 'production'] as const;
type NodeEnv = (typeof NODE_ENVS)[number];

const problems: string[] = [];

function read(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function required(name: string): string {
  const value = read(name);
  if (value === undefined) {
    problems.push(`${name} is required but missing or empty`);
    return '';
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return read(name) ?? fallback;
}

function integer(name: string, fallback: number): number {
  const value = read(name);
  if (value === undefined) return fallback;
  // Number() rather than parseInt(): parseInt('5000abc') silently yields 5000.
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    problems.push(`${name} must be a positive integer, got "${value}"`);
    return fallback;
  }
  return parsed;
}

/**
 * Like `integer`, but 0 is legal. Redis database index 0 is the default
 * database, not a missing value — `integer()` would reject it as
 * non-positive.
 */
function nonNegativeInteger(name: string, fallback: number): number {
  const value = read(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    problems.push(`${name} must be a non-negative integer, got "${value}"`);
    return fallback;
  }
  return parsed;
}

/**
 * A signing key short enough to brute-force makes the signature decorative.
 * 32 hex characters is the floor; `openssl rand -hex 32` gives 64.
 */
const MIN_SECRET_LENGTH = 32;

function secret(name: string): string {
  const value = required(name);
  if (value !== '' && value.length < MIN_SECRET_LENGTH) {
    problems.push(
      `${name} must be at least ${MIN_SECRET_LENGTH} characters, got ${value.length}. ` +
        'Generate one with: openssl rand -hex 32',
    );
  }
  return value;
}

function nodeEnv(): NodeEnv {
  const value = optional('NODE_ENV', 'development');
  if (!(NODE_ENVS as readonly string[]).includes(value)) {
    problems.push(`NODE_ENV must be one of ${NODE_ENVS.join(' | ')}, got "${value}"`);
    return 'development';
  }
  return value as NodeEnv;
}

const parsed = {
  NODE_ENV: nodeEnv(),
  PORT: integer('PORT', 5000),
  FRONTEND_URL: required('FRONTEND_URL'),

  PG_HOST: optional('PG_HOST', 'localhost'),
  PG_PORT: integer('PG_PORT', 5432),
  PG_USER: required('PG_USER'),
  PG_PASSWORD: required('PG_PASSWORD'),
  PG_DATABASE: required('PG_DATABASE'),

  // Background jobs and the webhook dispatcher (Phase 7). All optional — a
  // developer with default Docker settings must still boot with none of
  // these set.
  REDIS_HOST: optional('REDIS_HOST', 'localhost'),
  REDIS_PORT: integer('REDIS_PORT', 6379),
  REDIS_DB: nonNegativeInteger('REDIS_DB', 0),

  // Phase 9.5 — the Document Vault's filesystem backend. Optional: a fresh
  // checkout must boot with none of this set. Relative to the server package
  // root, because every npm script runs with cwd = server/.
  STORAGE_ROOT: path.resolve(process.cwd(), optional('STORAGE_ROOT', 'storage')),

  // Phase 10 — AP-Flow's vision extraction. Optional by design: the server
  // and the worker must both boot without it. extractionService throws 503
  // when a real extraction is attempted with no key, rather than failing at
  // import.
  ANTHROPIC_API_KEY: optional('ANTHROPIC_API_KEY', ''),

  // Two separate keys, deliberately. See docs/guardrails.md rule 11 — there is
  // no JWT_SECRET.
  ACCESS_TOKEN_SECRET: secret('ACCESS_TOKEN_SECRET'),
  REFRESH_TOKEN_SECRET: secret('REFRESH_TOKEN_SECRET'),
} as const;

// If the two keys are equal, a refresh token verifies as an access token: a
// stolen 7-day refresh cookie would become an unlimited-lifetime credential,
// and the whole point of the short access TTL disappears. Cheap check, real bug.
if (
  parsed.ACCESS_TOKEN_SECRET !== '' &&
  parsed.ACCESS_TOKEN_SECRET === parsed.REFRESH_TOKEN_SECRET
) {
  problems.push(
    'ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET must be different values — ' +
      'sharing one key lets a refresh token authenticate as an access token',
  );
}

if (problems.length > 0) {
  throw new Error(
    `Invalid server environment:\n  - ${problems.join('\n  - ')}\n\n` +
      'Copy server/.env.example to server/.env and fill it in.',
  );
}

export const env = {
  ...parsed,
  isProduction: parsed.NODE_ENV === 'production',
  isTest: parsed.NODE_ENV === 'test',
} as const;

export type Env = typeof env;
