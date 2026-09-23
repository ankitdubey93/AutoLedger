/**
 * StockLedger (Phase 28) — quantity formatting and parsing for a unit of
 * measure whose decimal precision varies per item (0–3 places), unlike the
 * fixed 3-decimal `quantity_milli` convention `utils/money.ts`'s
 * `parseQuantityInput` assumes for invoice/bill lines. String math
 * throughout — never a float round-trip (the same reasoning money.ts gives
 * for its own quantity and rate parsers).
 */

/** 2500 milli, 3 dp max → "2.5"; 1000 → "1"; trims trailing zeros. */
export function formatQuantityMilli(milli: number): string {
  const digits = String(Math.abs(milli)).padStart(4, '0');
  const whole = digits.slice(0, digits.length - 3);
  const fraction = digits.slice(digits.length - 3).replace(/0+$/, '');
  const sign = milli < 0 ? '-' : '';
  return fraction === '' ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

/**
 * "2.5" → 2500; rejects more decimals than `decimalPlaces` (a UoM with 0
 * decimal places rejects any fraction at all) → null; rejects negatives,
 * empty input and anything non-numeric → null.
 */
export function parseQuantityToMilli(text: string, decimalPlaces: number): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (match === null) return null;

  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > decimalPlaces) return null;

  const paddedFraction = fraction.padEnd(3, '0');
  const digits = `${whole}${paddedFraction}`.replace(/^0+(?=\d)/, '');
  if (!/^\d+$/.test(digits)) return null;

  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}
