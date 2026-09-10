/**
 * Money formatting and parsing for the client.
 *
 * The client mirrors the server's rule rather than relaxing it: amounts are
 * integer cents everywhere, and the only float in the system is the transient
 * one produced while parsing a user's typed "450.50".
 *
 * The server's `utils/money.ts` is not importable here — the two packages build
 * independently — so this is a deliberate, small duplication of the same rule.
 */

/** 45000 → "450.00". No currency symbol; the caller adds one if it wants. */
export function formatCents(value: number): string {
  const magnitude = Math.abs(value);
  const major = Math.trunc(magnitude / 100);
  const minor = magnitude % 100;
  return `${value < 0 ? '-' : ''}${String(major)}.${String(minor).padStart(2, '0')}`;
}

/**
 * Parses a typed amount into integer cents. Returns `null` for anything that is
 * not a non-negative money value, so a caller can show a field-level error
 * rather than silently posting a zero.
 *
 * Rounds half away from zero, matching the server. `Math.round` alone rounds
 * half toward +∞ and would treat the two signs differently.
 */
export function parseCentsInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return 0;
  // At most two decimal places — a third would be silently rounded away, and
  // silently changing someone's number is worse than rejecting it.
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;

  const scaled = Number(trimmed) * 100;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
  return Number.isSafeInteger(rounded) ? rounded : null;
}

/**
 * Parses a decimal string into an integer by shifting the decimal point —
 * string manipulation, not `Number(x) * scale`, so a many-digit input never
 * round-trips through a float. `maxDecimals` is how many digits the fraction
 * is padded or truncated to; `raw`'s fraction may not exceed it (matching
 * `parseCentsInput`'s "reject rather than silently round" rule).
 */
function parseShiftedInteger(raw: string, maxDecimals: number): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const match = /^(\d+)(?:\.(\d{1,}))?$/.exec(trimmed);
  if (match === null) return null;

  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').slice(0, maxDecimals);
  const paddedFraction = fraction.padEnd(maxDecimals, '0');
  const digits = `${whole}${paddedFraction}`.replace(/^0+(?=\d)/, '');
  if (!/^\d+$/.test(digits)) return null;

  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

/** Formats an integer scaled by `10**decimals` back to a decimal string, trimming trailing zeros. */
function formatShiftedInteger(value: number, decimals: number): string {
  const digits = String(Math.abs(value)).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  const sign = value < 0 ? '-' : '';
  return fraction === '' ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

/** '2.5' → 2500 thousandths. Returns null on anything unparseable. */
export function parseQuantityInput(raw: string): number | null {
  return parseShiftedInteger(raw, 3);
}

/** 2500 → '2.5' — trailing zeros trimmed, never a float round-trip. */
export function formatQuantity(quantityMilli: number): string {
  return formatShiftedInteger(quantityMilli, 3);
}

/** '18.5' → 1850 basis points. Returns null on anything unparseable. */
export function parseRateInput(raw: string): number | null {
  return parseShiftedInteger(raw, 2);
}

/** 1850 → '18.5'. */
export function formatRate(rateBp: number): string {
  return formatShiftedInteger(rateBp, 2);
}
