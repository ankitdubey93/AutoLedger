import type {
  SnapshotPerformance,
  SnapshotPosition,
  SnapshotRatio,
  SnapshotRatioKey,
  SnapshotRatioKind,
  SnapshotRatioValue,
} from '../types/accounting.js';
import { SNAPSHOT_RATIO_KEYS } from '../types/accounting.js';

export const SNAPSHOT_RATIO_SPECS: Record<
  SnapshotRatioKey,
  { label: string; kind: SnapshotRatioKind }
> = {
  GROSS_MARGIN: { label: 'Gross margin', kind: 'PERCENT' },
  CURRENT_RATIO: { label: 'Current ratio', kind: 'TIMES' },
  DEBT_RATIO: { label: 'Debt ratio', kind: 'PERCENT' },
  DEBT_TO_EQUITY: { label: 'Debt to equity', kind: 'TIMES' },
  WORKING_CAPITAL_TO_TOTAL_ASSETS: { label: 'Working capital to total assets', kind: 'PERCENT' },
  FIXED_ASSETS_TO_NET_WORTH: { label: 'Fixed assets to net worth', kind: 'TIMES' },
  CURRENT_LIABILITIES_TO_NET_WORTH: { label: 'Current liabilities to net worth', kind: 'PERCENT' },
};

/** numerator / denominator in bp, rounded half away from zero, exact (BigInt). */
export function ratioBp(numeratorCents: number, denominatorCents: number): SnapshotRatioValue {
  if (denominatorCents === 0) return { valueBp: null, reason: 'DENOMINATOR_ZERO' };
  if (denominatorCents < 0) return { valueBp: null, reason: 'DENOMINATOR_NEGATIVE' };
  const n = BigInt(numeratorCents) * 10000n;
  const d = BigInt(denominatorCents);
  const mag = (2n * (n < 0n ? -n : n) + d) / (2n * d);
  const valueBp = Number(n < 0n ? -mag : mag) + 0; // + 0 normalises -0
  return { valueBp, reason: null };
}

export function computeRatioValues(
  performance: SnapshotPerformance,
  position: SnapshotPosition,
): Record<SnapshotRatioKey, SnapshotRatioValue> {
  return {
    GROSS_MARGIN: ratioBp(performance.grossProfitCents, performance.revenueCents),
    CURRENT_RATIO: ratioBp(position.currentAssetsCents, position.currentLiabilitiesCents),
    DEBT_RATIO: ratioBp(position.totalLiabilitiesCents, position.totalAssetsCents),
    DEBT_TO_EQUITY: ratioBp(position.totalLiabilitiesCents, position.netWorthCents),
    WORKING_CAPITAL_TO_TOTAL_ASSETS: ratioBp(
      position.workingCapitalCents,
      position.totalAssetsCents,
    ),
    FIXED_ASSETS_TO_NET_WORTH: ratioBp(position.nonCurrentAssetsCents, position.netWorthCents),
    CURRENT_LIABILITIES_TO_NET_WORTH: ratioBp(
      position.currentLiabilitiesCents,
      position.netWorthCents,
    ),
  };
}

/** One SnapshotRatio per key, in SNAPSHOT_RATIO_KEYS order. */
export function buildRatios(
  current: { performance: SnapshotPerformance; position: SnapshotPosition },
  prior: { performance: SnapshotPerformance; position: SnapshotPosition },
): SnapshotRatio[] {
  const cur = computeRatioValues(current.performance, current.position);
  const pri = computeRatioValues(prior.performance, prior.position);
  return SNAPSHOT_RATIO_KEYS.map((key) => ({
    key,
    label: SNAPSHOT_RATIO_SPECS[key].label,
    kind: SNAPSHOT_RATIO_SPECS[key].kind,
    current: cur[key],
    prior: pri[key],
  }));
}
