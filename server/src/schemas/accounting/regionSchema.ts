import { z } from 'zod';
import { BAS_CYCLES, BAS_METHODS, GST_BASES } from '../../config/regions.js';
import { AU_TIME_ZONES } from '../../config/taxPacks/au.js';

export const gstSettingsSchema = z.object({
  registered: z.boolean(),
  basis: z.enum(GST_BASES),
  basCycle: z.enum(BAS_CYCLES),
  basMethod: z.enum(BAS_METHODS),
});

export const activateAustraliaSchema = z.object({
  gst: gstSettingsSchema,
  timezone: z.enum(AU_TIME_ZONES),
});

export const updateGstSettingsSchema = gstSettingsSchema
  .extend({ timezone: z.enum(AU_TIME_ZONES) })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });
