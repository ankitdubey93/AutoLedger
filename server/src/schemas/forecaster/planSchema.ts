import { z } from 'zod';
import { FORECASTER_PLAN_STATUSES } from '../../types/forecaster.js';

/**
 * ForecasterPro plans project in monthly calendar buckets, not LedgerCore's
 * fiscal periods — `startsOn`/`actualsThrough` are constrained to the first
 * of a month by both this regex and migration 035's CHECK.
 */
const FIRST_OF_MONTH = /^\d{4}-\d{2}-01$/;

export const createPlanSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
  description: z.string().trim().max(1000).nullable().default(null),
  startsOn: z.string().regex(FIRST_OF_MONTH, 'startsOn must be the first of a month (YYYY-MM-01)'),
  horizonMonths: z.number().int().min(1).max(60),
  actualsThrough: z
    .string()
    .regex(FIRST_OF_MONTH, 'actualsThrough must be the first of a month (YYYY-MM-01)'),
});

export const updatePlanSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).nullable(),
    startsOn: z.string().regex(FIRST_OF_MONTH, 'startsOn must be the first of a month (YYYY-MM-01)'),
    horizonMonths: z.number().int().min(1).max(60),
    actualsThrough: z
      .string()
      .regex(FIRST_OF_MONTH, 'actualsThrough must be the first of a month (YYYY-MM-01)'),
    status: z.enum(FORECASTER_PLAN_STATUSES),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');
