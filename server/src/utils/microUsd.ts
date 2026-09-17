import { ApiError } from './apiError.js';

/**
 * Operational AI spend, in millionths of one US dollar.
 *
 * NOT `Cents`, and deliberately not in utils/money.ts. Guardrails rule 3
 * governs LEDGER money: integer cents, never floats. This is not ledger
 * money — it is what a model call cost to run, it never reaches a journal
 * entry, and a single call routinely costs a small fraction of one cent,
 * which cents cannot represent at all. Its own brand makes "AI cost posted
 * as money" a compile error rather than a rounding argument.
 *
 * 1 USD = 1_000_000 MicroUsd. $0.002 = 2000.
 *
 * See study/architecture/metering-and-cost-attribution.md.
 */

declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

/** An integer number of millionths of one US dollar. Erased at compile time. */
export type MicroUsd = Brand<number, 'MicroUsd'>;

/** The only checked way to produce a MicroUsd. */
export function microUsd(value: number): MicroUsd {
  if (!Number.isInteger(value)) {
    throw new ApiError(400, 'Cost must be a whole number of micro-USD');
  }
  if (!Number.isSafeInteger(value)) {
    throw new ApiError(400, 'Cost is outside the safe integer range');
  }
  return value as MicroUsd;
}

/**
 * `pg` returns `BIGINT` as a string, deliberately — see money.ts's
 * `parseCents` for the full reasoning. This mirrors it exactly.
 */
export function parseMicroUsd(value: string): MicroUsd {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new ApiError(500, 'Unparseable cost value from database');
  }

  const exact = BigInt(trimmed);
  if (exact > BigInt(Number.MAX_SAFE_INTEGER) || exact < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new ApiError(500, 'Cost value from database exceeds the safe integer range');
  }

  return microUsd(Number(exact));
}

/**
 * 23400 -> "0.023400". Always six decimals — a single model call routinely
 * costs a small fraction of one cent, and four decimals would round that to
 * zero. No currency symbol — that is a locale decision the client owns.
 */
export function formatMicroUsd(value: MicroUsd): string {
  const magnitude = Math.abs(value);
  const dollars = Math.trunc(magnitude / 1_000_000);
  const micros = magnitude % 1_000_000;
  return `${value < 0 ? '-' : ''}${dollars}.${String(micros).padStart(6, '0')}`;
}

/**
 * Cost of `tokens` at `pricePerMTokMicroUsd` (the price of ONE MILLION
 * tokens, in MicroUsd). Exact BigInt arithmetic, rounding half up — the same
 * rule `scaleCents` uses, for the same reason: `tokens * price` overflows
 * `Number.MAX_SAFE_INTEGER` well inside the range a real request can reach.
 */
export function costMicroUsd(tokens: number, pricePerMTokMicroUsd: number): MicroUsd {
  if (!Number.isInteger(tokens) || tokens < 0) {
    throw new ApiError(400, 'Token count must be a non-negative whole number');
  }
  if (!Number.isInteger(pricePerMTokMicroUsd) || pricePerMTokMicroUsd < 0) {
    throw new ApiError(400, 'Invalid token price');
  }

  const t = BigInt(tokens);
  const p = BigInt(pricePerMTokMicroUsd);
  const result = (t * p + 500_000n) / 1_000_000n;

  return microUsd(Number(result));
}
