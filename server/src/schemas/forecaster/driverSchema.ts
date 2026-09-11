import { z } from 'zod';
import { FORECASTER_DRIVER_KINDS } from '../../types/forecaster.js';

const FIRST_OF_MONTH = /^\d{4}-\d{2}-01$/;

export const createDriverSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
  unitLabel: z.string().trim().max(40).default(''),
  kind: z.enum(FORECASTER_DRIVER_KINDS),
});

/**
 * `kind` is absent from `updateDriverSchema` deliberately — changing a
 * driver's kind would silently reinterpret every stored value and every
 * forecast line that references it. To change a kind, delete the driver
 * and create a new one.
 */
export const updateDriverSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    unitLabel: z.string().trim().max(40),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');

/** Bulk set. Replaces the named months only; months not listed are untouched. */
export const setDriverValuesSchema = z.object({
  values: z
    .array(
      z.object({
        month: z.string().regex(FIRST_OF_MONTH, 'month must be the first of a month (YYYY-MM-01)'),
        value: z.number().int(),
      }),
    )
    .min(1, 'values must not be empty')
    .max(60, 'values may contain at most 60 months'),
});
