import type { SnapshotRatioValue } from '../services/fetchServices';

/** 1250 PERCENT → "12.50%"; 58333 TIMES → "5.83×"; null → "—". Display only. */
export function formatRatio(kind: 'PERCENT' | 'TIMES', valueBp: number | null): string {
  if (valueBp === null) return '—';
  return kind === 'PERCENT' ? `${(valueBp / 100).toFixed(2)}%` : `${(valueBp / 10000).toFixed(2)}×`;
}

/** The tooltip text for an unavailable ratio. */
export function ratioUnavailableText(value: SnapshotRatioValue): string | null {
  if (value.reason === 'DENOMINATOR_ZERO') return 'Not available: the denominator is zero.';
  if (value.reason === 'DENOMINATOR_NEGATIVE') return 'Not meaningful: the denominator is negative (for example, negative net worth).';
  return null;
}
