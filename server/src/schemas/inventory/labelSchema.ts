import { z } from 'zod';
import { STOCK_LABEL_KINDS } from '../../types/inventory.js';

/** Request schema for Inventory's QR label sheet. */

export const labelRequestSchema = z.object({
  targets: z
    .array(z.object({ kind: z.enum(STOCK_LABEL_KINDS), id: z.uuid(), copies: z.int().min(1).max(100).default(1) }))
    .min(1)
    .max(200),
});
