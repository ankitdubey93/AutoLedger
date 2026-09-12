import { z } from 'zod';

/**
 * PATCH /unitecon/settings. Both fields optional, at least one required.
 * `acquisitionAccountIds` is a REPLACE set, not a merge — sending [] clears
 * the configuration, which is a legitimate action, not an error.
 */
export const updateSettingsSchema = z
  .object({
    grossMarginBps: z
      .number()
      .int('grossMarginBps must be a whole number of basis points')
      .min(0)
      .max(10000),
    acquisitionAccountIds: z
      .array(z.string().uuid('acquisitionAccountIds must contain UUIDs'))
      .max(50, 'At most 50 acquisition accounts may be configured'),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');
