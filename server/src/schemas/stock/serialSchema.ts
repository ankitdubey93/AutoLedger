import { z } from 'zod';

/** Request schemas for StockLedger's serial status changes and custom-field edits. */

export const serialStatusSchema = z.object({
  status: z.enum(['AVAILABLE', 'ON_HOLD', 'BOOKED']),
  note: z.string().trim().max(200).nullable().default(null),
});

export const serialAttributesSchema = z.object({
  attributes: z.record(z.string(), z.unknown()),
});
