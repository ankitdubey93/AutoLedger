import { z } from 'zod';

/**
 * PUT /ap-flow/settings — Phase 19's auto-post gates. `autoPostMinConfidence`
 * rejects a value with more than 3 decimal places to match the column's
 * `NUMERIC(4,3)` precision — silently truncating instead would let a saved
 * value differ from what the caller asked for.
 */
export const updateApFlowSettingsSchema = z.object({
  autoPostEnabled: z.boolean(),
  autoPostMinConfidence: z
    .number()
    .min(0.5, { message: 'autoPostMinConfidence must be at least 0.5' })
    .max(1, { message: 'autoPostMinConfidence must be at most 1' })
    .refine((v) => /^(0\.\d{1,3}|1(\.0{1,3})?)$/.test(String(v)), {
      message: 'autoPostMinConfidence allows at most 3 decimal places',
    }),
  autoPostMaxTotalCents: z.number().int().positive().nullable(),
});

export type UpdateApFlowSettingsInput = z.infer<typeof updateApFlowSettingsSchema>;
