import { ApiError } from './apiError.js';
import { MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH } from '../config/constants.js';

/**
 * Input validation, hand-rolled and deliberately small.
 *
 * `zod` is listed in docs/development.md as not-installed, and guardrails rule
 * 14 says no dependency before the phase that needs it. Phase 1's bodies are
 * flat objects of five scalars, which is squarely in the range where a handful
 * of type guards is clearer than a schema library. The revisit trigger is
 * recorded in docs/development.md: Phase 2's journal entries take a nested
 * `lines[]` array, and hand-rolling nested-array validation is where zod
 * starts paying for itself.
 *
 * Every function throws ApiError(400) so errorHandler.ts formats the response
 * — no controller hand-rolls one (docs/api.md).
 */

/** Narrows an Express body from `any`/`unknown` to something indexable. */
export function requireBodyObject(body: unknown): Record<string, unknown> {
  // `typeof null === 'object'`, and arrays are objects too — both would pass a
  // naive check and then read as `undefined` fields.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(400, 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

interface StringRules {
  min?: number;
  max?: number;
}

export function requireString(
  body: Record<string, unknown>,
  field: string,
  rules: StringRules = {},
): string {
  const value = body[field];
  if (typeof value !== 'string') {
    throw new ApiError(400, `"${field}" is required and must be a string`);
  }

  const trimmed = value.trim();
  const { min = 1, max = 255 } = rules;

  if (trimmed.length < min) {
    throw new ApiError(400, `"${field}" must be at least ${min} character(s)`);
  }
  if (trimmed.length > max) {
    throw new ApiError(400, `"${field}" must be at most ${max} characters`);
  }
  return trimmed;
}

/** Optional string field: absent or empty becomes null, never the string "undefined". */
export function optionalString(
  body: Record<string, unknown>,
  field: string,
  rules: StringRules = {},
): string | null {
  const value = body[field];
  if (value === undefined || value === null || value === '') return null;
  return requireString(body, field, rules);
}

/**
 * Deliberately permissive. Full RFC 5322 in a regex is a famous dead end, and
 * the only real proof an address exists is sending mail to it. This rejects
 * the obvious typos; `UNIQUE (LOWER(email))` handles identity.
 *
 * Lowercased here so every write is normalised at the boundary (rule 9).
 */
export function requireEmail(body: Record<string, unknown>, field = 'email'): string {
  const value = requireString(body, field, { max: 254 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new ApiError(400, `"${field}" must be a valid email address`);
  }
  return value.toLowerCase();
}

/**
 * Not trimmed — leading and trailing spaces are legitimate password characters
 * and silently stripping them would lock users out of a password they set.
 *
 * The upper bound is in **bytes**, not characters: bcrypt truncates at 72
 * bytes and ignores the rest, so without this check two different long
 * passwords sharing a 72-byte prefix would be interchangeable at login. A
 * multi-byte character makes `.length` the wrong measure, hence Buffer.
 */
export function requirePassword(body: Record<string, unknown>, field = 'password'): string {
  const value = body[field];
  if (typeof value !== 'string') {
    throw new ApiError(400, `"${field}" is required and must be a string`);
  }
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new ApiError(400, `"${field}" must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new ApiError(400, `"${field}" must be at most ${MAX_PASSWORD_BYTES} bytes`);
  }
  return value;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Checked before the value reaches a query. Postgres would reject a malformed
 * UUID anyway, but as a 500-shaped driver error rather than a clean 400.
 */
export function requireUuid(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ApiError(400, `"${field}" must be a valid UUID`);
  }
  return value;
}

/**
 * URL-safe organization slug derived from a name. Not unique on its own — the
 * caller resolves collisions (see authService.register).
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    // Strip combining marks so "Café" becomes "cafe" rather than losing the e.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  // A name of only punctuation or non-Latin script can slugify to "".
  return slug === '' ? 'org' : slug;
}
