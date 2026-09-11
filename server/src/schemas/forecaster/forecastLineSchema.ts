import { z } from 'zod';

/**
 * A discriminated union on `kind`, mirroring
 * `schemas/fpa-engine/assumptionSchema.ts` and migration 038's
 * `chk_forecaster_lines_kind_payload` CHECK.
 */
const base = { accountId: z.string().uuid(), label: z.string().trim().min(1).max(120) };

export const createForecastLineSchema = z.discriminatedUnion('kind', [
  z.object({
    ...base,
    kind: z.literal('DRIVER_PRODUCT'),
    quantityDriverId: z.string().uuid(),
    rateDriverId: z.string().uuid(),
  }),
  z.object({
    ...base,
    kind: z.literal('DRIVER_PERCENT'),
    sourceDriverId: z.string().uuid(),
    percentBps: z.number().int().min(0).max(100000),
  }),
  z.object({ ...base, kind: z.literal('FIXED_CENTS'), fixedCents: z.number().int() }),
]);

/**
 * Same union — an update always restates the whole line, so a kind change
 * can never leave a stale payload column behind. No `.partial()` here,
 * deliberately.
 */
export const updateForecastLineSchema = createForecastLineSchema;
