/**
 * Phase 45 — text forms of report cells for CSV/XLSX/PDF. Pure and integer-only:
 * money is never divided into a float (guardrail rule 3). Only the last helper
 * touches a number that is not money (a calendar day count).
 */

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 123456 -> "1234.56"; -5 -> "-0.05". */
export function centsToDecimal(cents: number): string {
  const magnitude = Math.abs(cents);
  const major = String(Math.trunc(magnitude / 100));
  const minor = String(magnitude % 100).padStart(2, '0');
  return `${cents < 0 ? '-' : ''}${major}.${minor}`;
}

/** 123456 -> "1,234.56"; -123456 -> "-1,234.56". */
export function groupedCents(cents: number): string {
  const magnitude = Math.abs(cents);
  const major = groupThousands(String(Math.trunc(magnitude / 100)));
  const minor = String(magnitude % 100).padStart(2, '0');
  return `${cents < 0 ? '-' : ''}${major}.${minor}`;
}

/** 1250 -> "0.1250"; -50 -> "-0.0050" (a fraction, for XLSX percent cells). */
export function bpToFraction(bp: number): string {
  const magnitude = Math.abs(bp);
  const whole = String(Math.trunc(magnitude / 10000));
  const frac = String(magnitude % 10000).padStart(4, '0');
  return `${bp < 0 ? '-' : ''}${whole}.${frac}`;
}

/** 1250 -> "12.50%"; null -> "". */
export function bpToPercentText(bp: number | null): string {
  if (bp === null) return '';
  const magnitude = Math.abs(bp);
  const whole = String(Math.trunc(magnitude / 100));
  const frac = String(magnitude % 100).padStart(2, '0');
  return `${bp < 0 ? '-' : ''}${whole}.${frac}%`;
}

/** 2500 -> "2.5"; 1000 -> "1"; 1234 -> "1.234" (trailing zeros trimmed). */
export function milliToDecimal(milli: number): string {
  const magnitude = Math.abs(milli);
  const whole = String(Math.trunc(magnitude / 1000));
  const frac = String(magnitude % 1000).padStart(3, '0').replace(/0+$/, '');
  const sign = milli < 0 ? '-' : '';
  return frac === '' ? `${sign}${whole}` : `${sign}${whole}.${frac}`;
}

/** '1970-01-01' -> 25569; '2026-10-16' -> 46311 (Excel's 1900 date system). */
export function isoToExcelSerial(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86400000 + 25569;
}
