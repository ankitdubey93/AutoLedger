import { ApiError } from './apiError.js';

/**
 * Money. Integer cents, always — guardrails rule 3.
 *
 * The prior build validated balance in cents but stored `DECIMAL`, and computed
 * its `isBalanced` flag with a `< 0.01` epsilon. The system's central invariant
 * was therefore checked with a tolerance that drifts as data grows. This module
 * is the single place a raw `number` becomes money, so the rounding rule has one
 * implementation and one set of tests.
 *
 * See study/typescript/branded-types-for-money.md.
 */

/**
 * TypeScript is structural, so `type Cents = number` would be freely
 * interchangeable with any other number — including dollars. Branding
 * intersects the primitive with a phantom property to fake nominal typing.
 *
 * The key is a `unique symbol` rather than a string property (`__brand`): it
 * cannot be forged from outside this module, cannot collide with another
 * library's brand, and does not show up in autocomplete.
 */
declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

/**
 * An integer number of minor currency units. Erased at compile time — a `Cents`
 * *is* a `number` at runtime, so arithmetic and JSON serialisation cost nothing.
 */
export type Cents = Brand<number, 'Cents'>;

/**
 * The only checked way to produce a `Cents`.
 *
 * `as Cents` appears in this file and nowhere else in the codebase. A cast on
 * unvalidated input defeats the entire point of the brand — it would assert the
 * value had been checked when it had not.
 */
export function cents(value: number): Cents {
  if (!Number.isInteger(value)) {
    throw new ApiError(400, 'Amount must be a whole number of cents');
  }
  if (!Number.isSafeInteger(value)) {
    throw new ApiError(400, 'Amount is outside the safe integer range');
  }
  return value as Cents;
}

/**
 * Major units (450.5) → cents (45050). Rounds half away from zero, so -0.005
 * and 0.005 round symmetrically — `Math.round` alone rounds half toward +∞ and
 * would treat the two signs differently.
 *
 * Binary floating point still bites before this function is ever called:
 * `1.005 * 100` is `100.49999999999999`, so `toCents(1.005)` is 100, not 101.
 * That is a property of the `number` the caller already holds, not of the
 * rounding here — which is exactly why money is never stored as one. Parse
 * money from strings at the HTTP boundary wherever the source is textual.
 */
export function toCents(major: number): Cents {
  if (!Number.isFinite(major)) {
    throw new ApiError(400, 'Amount must be a finite number');
  }
  const scaled = major * 100;
  return cents(Math.sign(scaled) * Math.round(Math.abs(scaled)));
}

/**
 * `pg` returns `BIGINT` as a **string**, deliberately: a 64-bit integer exceeds
 * `Number.MAX_SAFE_INTEGER` (2⁵³−1), so parsing eagerly could lose precision in
 * silence. Every money value read from the database passes through here.
 *
 * Parsing via `BigInt` first is what makes the range check honest —
 * `Number.parseInt('9007199254740993')` returns 9007199254740992 without
 * complaint, which is the precision loss this guards against.
 */
export function parseCents(value: string): Cents {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new ApiError(500, 'Unparseable money value from database');
  }

  const exact = BigInt(trimmed);
  if (exact > BigInt(Number.MAX_SAFE_INTEGER) || exact < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new ApiError(500, 'Money value from database exceeds the safe integer range');
  }

  return cents(Number(exact));
}

/**
 * 45000 → "450.00". No currency symbol and no thousands separator — those are
 * locale decisions and belong to the client, which knows the user's locale.
 */
export function formatCents(value: Cents): string {
  const magnitude = Math.abs(value);
  const major = Math.trunc(magnitude / 100);
  const minor = magnitude % 100;
  return `${value < 0 ? '-' : ''}${major}.${String(minor).padStart(2, '0')}`;
}

/**
 * Arithmetic loses the brand — `Cents + Cents` widens back to `number` — so the
 * operators re-brand deliberately rather than leaving callers to cast.
 */
export function addCents(a: Cents, b: Cents): Cents {
  return cents(a + b);
}

export function sumCents(values: readonly Cents[]): Cents {
  return values.reduce(addCents, cents(0));
}
