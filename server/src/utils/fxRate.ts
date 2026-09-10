import { ApiError } from './apiError.js';
import { scaleCents, type Cents } from './money.js';

/**
 * Exchange-rate arithmetic. Phase 8's rate is `NUMERIC(18,8)`, always a
 * string end to end — never a `number`, and never routed through a float
 * multiplication. See study/postgresql/multi-currency-and-functional-currency.md.
 */

/**
 * `fx_rates.rate` and `ledger_lines.fx_rate` are both NUMERIC(18,8), so a
 * rate's fractional part is scaled to an 8-digit integer numerator over this
 * denominator before it ever reaches `scaleCents`.
 */
export const RATE_SCALE = 100_000_000;

/**
 * Matches chk_fx_rates_rate_range (022). Keeps a rate's integer numerator
 * (rate x RATE_SCALE) at or under 1e14, comfortably inside
 * Number.MAX_SAFE_INTEGER (~9.007e15) — the range that lets rateNumerator
 * produce a safe integer with no bespoke big-number parser.
 */
export const MAX_RATE = 1_000_000;

/** The rate a base-currency amount is recorded at. Always this exact string. */
export const ONE_RATE = '1.00000000';

export function isCurrencyCode(value: string): boolean {
  return /^[A-Z]{3}$/.test(value);
}

/**
 * '83.50000000' -> 8350000000 (83.5 x RATE_SCALE).
 *
 * `pg` returns NUMERIC as a string, deliberately — the same reasoning
 * money.ts's parseCents documents for BIGINT. This is the one place a rate
 * string becomes a number; every conversion in the codebase must go through
 * it rather than reimplementing the parse.
 */
export function rateNumerator(rate: string): number {
  const trimmed = rate.trim();
  const match = /^(\d{1,10})(?:\.(\d{1,8}))?$/.exec(trimmed);
  if (match === null) {
    throw new ApiError(500, 'Unparseable exchange rate from database');
  }

  const wholePart = match[1] ?? '0';
  const fractionPart = (match[2] ?? '').padEnd(8, '0');
  const numerator = Number.parseInt(wholePart + fractionPart, 10);

  if (
    !Number.isSafeInteger(numerator) ||
    numerator <= 0 ||
    numerator > MAX_RATE * RATE_SCALE
  ) {
    throw new ApiError(500, 'Unparseable exchange rate from database');
  }

  return numerator;
}

/**
 * nativeCents x rate, exact, half-up, via scaleCents — never a float
 * multiplication (`Number(rate) * cents` is the line this function exists to
 * prevent). Postgres `round(numeric)` rounds half away from zero, which is
 * the same rule for the non-negative amounts every ledger line holds — the
 * identity migration 023's chk_ledger_lines_base_matches_rate depends on.
 */
export function convertToBase(nativeCents: Cents, rate: string): Cents {
  return scaleCents(nativeCents, rateNumerator(rate), RATE_SCALE);
}

/** 83.5 -> '83.50000000'. Used only where a rate must be written as a literal. */
export function formatRate(value: number): string {
  return value.toFixed(8);
}
