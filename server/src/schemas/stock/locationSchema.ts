import { z } from 'zod';
import { STOCK_LOCATION_KINDS } from '../../types/stock.js';

/** Request schemas for StockLedger's location hierarchy. `code`, `kind` and `parentId` are frozen once created. */

export const createLocationSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{0,19}$/),
  name: z.string().trim().min(1).max(100),
  kind: z.enum(STOCK_LOCATION_KINDS),
  parentId: z.uuid().nullable().default(null),
});

export const updateLocationSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });
