import { z } from 'zod';

/**
 * A discriminated union mirroring migration 034's
 * chk_fpa_assumptions_kind_payload CHECK — a payload/kind mismatch is a 400
 * at the edge, so the DB constraint is the backstop, not the first line of
 * defence.
 */
export const upsertAssumptionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('GROWTH_BPS'), growthBps: z.number().int().min(-10000).max(100000) }),
  z.object({ kind: z.literal('FIXED_CENTS'), fixedCents: z.number().int() }),
  z.object({
    kind: z.literal('PERCENT_OF_REVENUE_BPS'),
    percentOfRevenueBps: z.number().int().min(0).max(10000),
  }),
]);
