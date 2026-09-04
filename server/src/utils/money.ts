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

/**
 * Scales a money amount by a rational factor, rounding half up, in exact
 * integer arithmetic. `numerator` and `denominator` are plain integers —
 * basis points over 10000 for a tax rate, thousandths over 1000 for a
 * quantity — never a float ratio.
 *
 * `BigInt`, not `Math.round(amount * numerator / denominator)`: an invoice
 * line's `quantityMilli * unitPriceCents` can exceed
 * `Number.MAX_SAFE_INTEGER` well inside the range the columns permit, and a
 * float multiplication would round silently before this function ever saw
 * the value.
 */
export function scaleCents(amount: Cents, numerator: number, denominator: number): Cents {
  if (!Number.isInteger(denominator) || denominator <= 0) {
    throw new ApiError(400, 'Invalid scaling factor');
  }
  if (!Number.isInteger(numerator) || numerator < 0) {
    throw new ApiError(400, 'Invalid scaling factor');
  }

  const n = BigInt(numerator);
  const d = BigInt(denominator);
  const result = (BigInt(amount) * n + d / 2n) / d;

  return cents(Number(result));
}

/**
 * Parses money from untrusted text (a bank CSV export) into integer cents,
 * without ever producing an intermediate float. See toCents's comment on
 * why `1.005 * 100` is `100.49999999999999` — the same reasoning against a
 * float rules out `Number(text) * 100` or `parseFloat` here too.
 *
 * Separator ambiguity ("1,234.56" vs "1.234,56") is resolved by treating
 * whichever of `.`/`,` occurs last as the decimal point when both are
 * present. When only a comma appears, it counts as a decimal point iff it
 * occurs exactly once and is followed by exactly one or two digits — a
 * comma is overwhelmingly a thousands separator in English-language bank
 * exports, so anything else strips every comma. A lone dot is judged the
 * opposite way round: it is always presumed a decimal point (the common
 * case), so it is never reinterpreted as a thousands separator — a single
 * dot followed by anything but one or two digits (a third fraction digit,
 * or none at all) is left as-is and rejected by the final validation
 * pattern below rather than silently guessed at.
 */
export function parseMoneyText(raw: string): Cents {
  let text = raw.trim();
  // Strip currency symbols and spaces used as thousands separators.
  text = text.replace(/[$£€₹¥'\s]/g, '');

  if (text === '' || text === '-' || text === '—' || text.toLowerCase() === 'n/a') {
    return cents(0);
  }

  let negative = false;

  // Accounting-style negative: wrapped in parentheses.
  const parenMatch = /^\((.*)\)$/.exec(text);
  if (parenMatch) {
    negative = true;
    text = parenMatch[1] ?? '';
  }

  if (text.startsWith('-')) {
    negative = true;
    text = text.slice(1);
  }

  // CR/DR suffix.
  const crMatch = /CR$/i.exec(text);
  const drMatch = /DR$/i.exec(text);
  if (crMatch) {
    text = text.slice(0, -2);
  } else if (drMatch) {
    negative = true;
    text = text.slice(0, -2);
  }

  // A trailing 3-letter currency code, e.g. "1234.56 GBP" (already stripped
  // of the space above, so this is now "1234.56GBP").
  text = text.replace(/[A-Za-z]{3}$/, '');

  if (text === '') {
    return cents(0);
  }

  const hasDot = text.includes('.');
  const hasComma = text.includes(',');

  let normalized: string;
  if (hasDot && hasComma) {
    const lastDot = text.lastIndexOf('.');
    const lastComma = text.lastIndexOf(',');
    if (lastDot > lastComma) {
      // '.' is the decimal separator; every ',' is a thousands separator.
      normalized = text.replace(/,/g, '');
    } else {
      // ',' is the decimal separator; every '.' is a thousands separator.
      normalized = text.replace(/\./g, '').replace(',', '.');
    }
  } else if (hasComma) {
    const commaCount = (text.match(/,/g) ?? []).length;
    const afterLastComma = text.slice(text.lastIndexOf(',') + 1);
    const isDecimal = commaCount === 1 && /^\d{1,2}$/.test(afterLastComma);
    normalized = isDecimal ? text.replace(',', '.') : text.replace(/,/g, '');
  } else if (hasDot) {
    const dotCount = (text.match(/\./g) ?? []).length;
    if (dotCount === 1) {
      // A single dot is always presumed decimal — left unchanged either
      // way, so a bad fraction (3+ digits, or none) fails validation below
      // rather than being silently reinterpreted as thousands grouping.
      normalized = text;
    } else {
      // Multiple dots: only a properly thousands-grouped integer (each
      // group after the first exactly 3 digits, e.g. "1.234.567") is
      // reinterpreted. Anything else — including a malformed run like
      // "1.2.3" — is left as-is, and the final validation pattern below
      // rejects it outright because it still contains more than one dot.
      const isThousandsGrouped = /^\d{1,3}(\.\d{3})+$/.test(text);
      normalized = isThousandsGrouped ? text.replace(/\./g, '') : text;
    }
  } else {
    normalized = text;
  }

  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new ApiError(400, `Unparseable amount "${raw}"`);
  }

  const [integerPart, fractionPart] = normalized.split('.');
  const fractionPadded = (fractionPart ?? '').padEnd(2, '0');
  const magnitude = BigInt(integerPart ?? '0') * 100n + BigInt(fractionPadded === '' ? '0' : fractionPadded);
  const signed = negative ? -magnitude : magnitude;

  return cents(Number(signed));
}
