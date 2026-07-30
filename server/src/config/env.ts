import 'dotenv/config';

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
} as const;

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
