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

/**
 * Like `optional`, but the value must be one of a fixed set of literals.
 * Phase 19 — AP-Flow's provider switch is the first user of this.
 */
function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = read(name);
  if (value === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    problems.push(`${name} must be one of ${allowed.join(' | ')}, got "${value}"`);
    return fallback;
  }
  return value as T;
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

  // Phase 19 — which vision/classification provider AP-Flow uses. Optional;
  // defaults to anthropic. Only the selected provider's key needs to be set.
  AP_FLOW_AI_PROVIDER: oneOf('AP_FLOW_AI_PROVIDER', ['anthropic', 'gemini'] as const, 'anthropic'),
  // Google AI Studio / Gemini API key, called over fetch — no SDK (rule 14).
  // Optional by design, exactly as ANTHROPIC_API_KEY.
  GEMINI_API_KEY: optional('GEMINI_API_KEY', ''),
  AP_FLOW_GEMINI_MODEL: optional('AP_FLOW_GEMINI_MODEL', 'gemini-3.6-flash'),

  // Phase 16 — TaxGuard AI's embeddings provider (Voyage AI). Optional by
  // design, exactly as ANTHROPIC_API_KEY: the server and worker both boot
  // without it, and embeddingService throws 503 only when an embedding is
  // actually attempted.
  VOYAGE_API_KEY: optional('VOYAGE_API_KEY', ''),

  // Phase 19.3 — the Drive integration's service account, the recommended way
  // to connect. The tenant shares a folder with GOOGLE_SERVICE_ACCOUNT_EMAIL
  // and no consent screen, no Google app verification and no refresh token are
  // involved. Optional, exactly as ANTHROPIC_API_KEY: the server and worker
  // both boot without them and driveConnectionService throws 503 only when a
  // real Drive action is attempted.
  //
  // The address is NOT a secret — it is published to the tenant so they know
  // who to share with, and GET /integrations/drive returns it. The private key
  // is, and is never written to a table, never logged, and never returned by
  // any route. It stays a plain env var for the same reason GEMINI_API_KEY and
  // VOYAGE_API_KEY do: encrypting a server-wide secret in the database would
  // still leave INTEGRATION_ENCRYPTION_KEY sitting in plaintext env, so the
  // ciphertext would protect nothing the env var did not already protect.
  GOOGLE_SERVICE_ACCOUNT_EMAIL: optional('GOOGLE_SERVICE_ACCOUNT_EMAIL', ''),
  // Google's downloaded JSON key carries a PEM with real newlines; a .env file
  // cannot hold them. Accept the conventional \n-escaped single line and
  // unescape here — this is the one place that reads process.env, so it is the
  // one place the unescaping belongs.
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: optional('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', '').replace(
    /\\n/g,
    '\n',
  ),

  // Phase 19.2 — the Drive integration's OAuth mode, retained as the secondary
  // path. All optional, same reasoning as above.
  //
  // NOTE: an external OAuth app whose Google publishing status is "Testing" is
  // issued refresh tokens that expire after 7 days, so an OAUTH connection on
  // an unverified app dies weekly. That is why the service account above is the
  // recommended path and this one is the fallback.
  GOOGLE_OAUTH_CLIENT_ID: optional('GOOGLE_OAUTH_CLIENT_ID', ''),
  GOOGLE_OAUTH_CLIENT_SECRET: optional('GOOGLE_OAUTH_CLIENT_SECRET', ''),
  // CHANGED IN 19.3: the callback moved with the integration, from
  // /api/v1/ap-flow/drive to /api/v1/integrations/drive. A .env still naming
  // the old path keeps working — routes/ap-flow/driveRoutes.ts retains that one
  // route as a legacy alias, because the redirect URI is also registered in an
  // operator's Google Cloud Console, outside this repo.
  GOOGLE_OAUTH_REDIRECT_URI: optional(
    'GOOGLE_OAUTH_REDIRECT_URI',
    'http://localhost:5000/api/v1/integrations/drive/oauth/callback',
  ),
  // AES-256-GCM key for refresh tokens and PKCE verifiers at rest
  // (utils/secretBox.ts) — NOT a JWT secret (rule 11), a separate concern.
  INTEGRATION_ENCRYPTION_KEY: optional('INTEGRATION_ENCRYPTION_KEY', ''),

  // Two separate keys, deliberately. See docs/guardrails.md rule 11 — there is
  // no JWT_SECRET.
  ACCESS_TOKEN_SECRET: secret('ACCESS_TOKEN_SECRET'),
  REFRESH_TOKEN_SECRET: secret('REFRESH_TOKEN_SECRET'),
} as const;

// A key that is set but the wrong length is a misconfiguration worth
// failing loudly on, the same posture ACCESS_TOKEN_SECRET's length check
// takes — a silently-truncated or padded key would decrypt nothing later.
if (
  parsed.INTEGRATION_ENCRYPTION_KEY !== '' &&
  !/^[0-9a-fA-F]{64}$/.test(parsed.INTEGRATION_ENCRYPTION_KEY)
) {
  problems.push(
    'INTEGRATION_ENCRYPTION_KEY must be 64 hex characters (32 bytes). ' +
      'Generate one with: openssl rand -hex 32',
  );
}

// A service-account key that is set but malformed is a misconfiguration worth
// failing loudly on, the same posture the hex check above takes. The common
// mistake is pasting the JSON key's `private_key` field with its \n escapes
// already collapsed, or pasting the whole JSON object instead of the one field;
// both produce something node:crypto rejects only at first signing, which would
// otherwise surface as a confusing 502 during a folder sync hours later.
if (
  parsed.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY !== '' &&
  !parsed.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.startsWith('-----BEGIN PRIVATE KEY-----')
) {
  problems.push(
    'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY must be a PKCS#8 PEM beginning with ' +
      '-----BEGIN PRIVATE KEY-----. Copy the `private_key` field from the ' +
      'service account JSON key, keeping its \\n escapes.',
  );
}

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
