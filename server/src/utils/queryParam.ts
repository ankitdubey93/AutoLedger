import type { Request } from 'express';
import { ApiError } from './apiError.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../config/constants.js';

/**
 * Query-string readers shared across list and report endpoints.
 *
 * Each reader owns one failure mode and one message, so a caller does not
 * reinvent the check (and the message) per controller. Nothing here is ever
 * interpolated into SQL — these produce filter *values*, never identifiers
 * (guardrails rule 4).
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Clamps pagination input; a caller asking for 10,000 rows gets MAX_PAGE_SIZE. */
export function readPagination(query: unknown): { page: number; limit: number } {
  const params = query as Record<string, unknown>;
  const rawPage = Number(params.page ?? 1);
  const rawLimit = Number(params.limit ?? DEFAULT_PAGE_SIZE);

  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit =
    Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;

  return { page, limit };
}

/** `null` when absent; a `YYYY-MM-DD` string; throws 400 otherwise. */
export function optionalIsoDate(req: Request, name: string): string | null {
  const value = req.query[name];
  if (value === undefined) return null;
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    throw new ApiError(400, `${name} must be a date in YYYY-MM-DD format`);
  }
  return value;
}

/** `null` when absent; a UUID string; throws 400 otherwise. */
export function optionalUuid(req: Request, name: string): string | null {
  const value = req.query[name];
  if (value === undefined) return null;
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new ApiError(400, `${name} must be a UUID`);
  }
  return value;
}

/**
 * `null` when absent or blank — an empty filter box must not become a filter.
 * Otherwise the trimmed value, or throws 400 if it exceeds `maxLength`.
 */
export function optionalText(req: Request, name: string, maxLength: number): string | null {
  const value = req.query[name];
  if (value === undefined) return null;
  if (typeof value !== 'string') {
    throw new ApiError(400, `${name} must be at most ${String(maxLength)} characters`);
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > maxLength) {
    throw new ApiError(400, `${name} must be at most ${String(maxLength)} characters`);
  }
  return trimmed;
}
