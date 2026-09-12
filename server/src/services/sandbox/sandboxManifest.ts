import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ZodType } from 'zod';
import { ApiError } from '../../utils/apiError.js';
import { manifestSchema, type SandboxManifestFile } from '../../schemas/sandboxSchema.js';

/**
 * Phase 18 — reads `sandbox/` at the repo root. Every npm script (`dev`,
 * `test`, `migrate`, and this phase's `seed:demo`) runs with
 * `process.cwd() === server/`, the identical convention `config/env.ts`'s
 * `STORAGE_ROOT` already relies on. So `sandbox/` is one level up.
 *
 * This file touches no database — it is a pure file-reading and validating
 * layer, imported by every per-app `sandboxSeed.ts` and by the fixture-
 * validation unit test, neither of which needs Postgres to exercise it.
 */

const SANDBOX_ROOT = path.resolve(process.cwd(), '..', 'sandbox');

export function sandboxPath(relativePath: string): string {
  return path.join(SANDBOX_ROOT, relativePath);
}

async function readJson(relativePath: string): Promise<unknown> {
  const filePath = sandboxPath(relativePath);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    throw new ApiError(500, `Sandbox fixture not found: ${relativePath}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(500, `Sandbox fixture is not valid JSON: ${relativePath}`);
  }
}

export async function loadManifest(): Promise<SandboxManifestFile> {
  const json = await readJson('manifest.json');
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(500, `Sandbox manifest failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Reads and zod-parses one fixture file, relative to `sandbox/`. */
export async function loadFixture<T>(relativePath: string, schema: ZodType<T>): Promise<T> {
  const json = await readJson(relativePath);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(500, `Sandbox fixture "${relativePath}" failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Resolves a fixture's relative `monthOffset` (-23..0) and `day` (1..28) to a
 * real 'YYYY-MM-DD', relative to an anchor month ('YYYY-MM-01'). Fixtures
 * carry no absolute dates — an absolute date rots, drifting out of the
 * cohort display window and the fiscal year within months of being written.
 *
 * `day` is capped at 28 by the schema layer so every resolved date is valid
 * in every month, including February.
 */
export function resolveMonth(anchorMonth: string, offset: number, day: number): string {
  if (day < 1 || day > 28) {
    throw new Error(`resolveMonth: day must be 1..28, got ${String(day)}`);
  }
  const match = /^(\d{4})-(\d{2})-01$/.exec(anchorMonth);
  if (match === null) {
    throw new Error(`resolveMonth: anchorMonth must be 'YYYY-MM-01', got "${anchorMonth}"`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);

  // Date.UTC normalizes an out-of-range month index (e.g. -1 or 13) into a
  // year rollover, which is exactly the arithmetic a relative offset needs.
  const resolved = new Date(Date.UTC(year, month - 1 + offset, day));
  const yyyy = String(resolved.getUTCFullYear()).padStart(4, '0');
  const mm = String(resolved.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(resolved.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Adds `days` (any integer, including large ones like a 52-day payment
 * term) to a real 'YYYY-MM-DD' date, returning a real date — genuine
 * calendar arithmetic, deliberately separate from `resolveMonth`. A due
 * date is "N days after an issue date," not "day D of some offset month,"
 * and `resolveMonth`'s `day` parameter is capped at 28 precisely because it
 * answers the second question, not the first; using it for the first would
 * silently produce an invalid date for any term past day 28.
 */
export function addDays(dateStr: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (match === null) {
    throw new Error(`addDays: expected 'YYYY-MM-DD', got "${dateStr}"`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const resolved = new Date(Date.UTC(year, month - 1, day + days));
  const yyyy = String(resolved.getUTCFullYear()).padStart(4, '0');
  const mm = String(resolved.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(resolved.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** 'YYYY-MM-01' for the current month, in UTC. */
export function currentAnchorMonth(): string {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear()).padStart(4, '0');
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}-01`;
}
