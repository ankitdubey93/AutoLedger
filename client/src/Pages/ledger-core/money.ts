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
