import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from '../config/currencies.js';

/**
 * Request schema for editing the active organization. Platform layer,
 * unprefixed — mirrors `schemas/ledger-core/settingsSchema.ts`'s shape but
 * lives at the layer root because `organizations` is a platform table.
 */
export const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    baseCurrency: z.enum(SUPPORTED_CURRENCIES).optional(),
    taxNumber: z.string().trim().max(64).nullable().optional(),
    businessNumber: z.string().trim().max(64).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'No fields to update',
  });
