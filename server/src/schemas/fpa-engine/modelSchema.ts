import { z } from 'zod';
import { FPA_MODEL_STATUSES, FPA_SCENARIO_KINDS } from '../../types/fpa-engine.js';

/**
 * FP&A models and scenarios project in monthly calendar buckets, not
 * LedgerCore's fiscal periods — `startsOn`/`actualsThrough` are constrained
 * to the first of a month by both this regex and migration 033's CHECK.
 */
const FIRST_OF_MONTH = /^\d{4}-\d{2}-01$/;

export const createModelSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
  description: z.string().trim().max(1000).nullable().default(null),
  startsOn: z.string().regex(FIRST_OF_MONTH, 'startsOn must be the first of a month (YYYY-MM-01)'),
  horizonMonths: z.number().int().min(1).max(60),
  actualsThrough: z
    .string()
    .regex(FIRST_OF_MONTH, 'actualsThrough must be the first of a month (YYYY-MM-01)'),
});

export const updateModelSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).nullable(),
    startsOn: z.string().regex(FIRST_OF_MONTH, 'startsOn must be the first of a month (YYYY-MM-01)'),
    horizonMonths: z.number().int().min(1).max(60),
    actualsThrough: z
      .string()
      .regex(FIRST_OF_MONTH, 'actualsThrough must be the first of a month (YYYY-MM-01)'),
    status: z.enum(FPA_MODEL_STATUSES),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');

export const createScenarioSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
  kind: z.enum(FPA_SCENARIO_KINDS).default('CUSTOM'),
  dsoDays: z.number().int().min(0).max(365).default(0),
  dpoDays: z.number().int().min(0).max(365).default(0),
  taxRateBps: z.number().int().min(0).max(10000).default(0),
});

/**
 * `isDefault` accepts only `true` — promoting a scenario to default is the
 * only legal move via this endpoint. Un-defaulting would leave a model with
 * no default scenario, which migration 033's ux_fpa_scenarios_one_default
 * partial unique index cannot express and the service must not attempt.
 */
export const updateScenarioSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(FPA_SCENARIO_KINDS),
    isDefault: z.literal(true),
    dsoDays: z.number().int().min(0).max(365),
    dpoDays: z.number().int().min(0).max(365),
    taxRateBps: z.number().int().min(0).max(10000),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');
