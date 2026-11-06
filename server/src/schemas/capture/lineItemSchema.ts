import { z } from 'zod';

const PURCHASE_CODES = ['P_GST', 'P_CAP_GST', 'P_FREE', 'P_CAP_FREE', 'P_INPUT_TAXED', 'P_PRIVATE', 'P_EXCLUDED'] as const;

export const updateLineItemSchema = z
  .object({
    accountId: z.uuid({ message: 'accountId must be a UUID' }).optional(),
    // Phase 49f — a reviewer's GST code; null puts the line back to automatic.
    taxCode: z.enum(PURCHASE_CODES).nullable().optional(),
  })
  .refine((v) => v.accountId !== undefined || v.taxCode !== undefined, { message: 'Nothing to update' });

export type UpdateLineItemInput = z.infer<typeof updateLineItemSchema>;
