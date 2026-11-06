/**
 * Jurisdiction packs (Phase 49). A region is one column on the organization,
 * not a module: the engine stays one codebase and a pack contributes rules,
 * and a GENERIC organization behaves exactly as if no pack existed.
 */
export const REGIONS = ['GENERIC', 'AU'] as const;
export type Region = (typeof REGIONS)[number];

export function isRegion(value: string): value is Region {
  return (REGIONS as readonly string[]).includes(value);
}

export const GST_BASES = ['CASH', 'ACCRUAL'] as const;
export type GstBasis = (typeof GST_BASES)[number];

export const BAS_CYCLES = ['QUARTERLY', 'MONTHLY'] as const;
export type BasCycle = (typeof BAS_CYCLES)[number];

export const BAS_METHODS = ['SIMPLER', 'FULL'] as const;
export type BasMethod = (typeof BAS_METHODS)[number];
