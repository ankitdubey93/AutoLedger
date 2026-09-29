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

/** Inserts a comma every three digits from the right: "1234567" → "1,234,567". String work, no float. */
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 123456789 → "1,234,567.89". No currency symbol; the caller adds one if it wants.
 *
 * Grouped for reading, and still safe to pre-fill an input with:
 * `parseCentsInput` accepts exactly this grouping back.
 */
export function formatCents(value: number): string {
  const [sign, major, minor] = splitCents(value);
  return `${sign}${groupThousands(major)}.${minor}`;
}

/**
 * 123456789 → "1234567.89" — ungrouped, for machine-read output (a CSV the
 * server parses). Display text uses formatCents.
 */
export function formatCentsPlain(value: number): string {
  const [sign, major, minor] = splitCents(value);
  return `${sign}${major}.${minor}`;
}

function splitCents(value: number): [sign: string, major: string, minor: string] {
  const magnitude = Math.abs(value);
  return [value < 0 ? '-' : '', String(Math.trunc(magnitude / 100)), String(magnitude % 100).padStart(2, '0')];
}

/**
 * Micro-USD (millionths of a dollar) -> a display string. AI spend, never
 * ledger money — see server/src/utils/microUsd.ts. Four decimals, because a
 * single model call routinely costs well under one cent.
 */
export function formatMicroUsd(value: number): string {
  const magnitude = Math.abs(value);
  const dollars = Math.trunc(magnitude / 1_000_000);
  const fraction = Math.round((magnitude % 1_000_000) / 100); // micro -> 4-decimal fraction
  return `${value < 0 ? '-' : ''}${String(dollars)}.${String(fraction).padStart(4, '0')}`;
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
  const typed = raw.trim();
  if (typed === '') return 0;
  // Thousands separators are accepted only when correctly grouped ("1,234.50"),
  // which is exactly what formatCents prints. "1,25" is refused rather than
  // guessed at — in much of the world that comma is the decimal point.
  if (typed.includes(',') && !/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(typed)) return null;
  const trimmed = typed.replaceAll(',', '');
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
