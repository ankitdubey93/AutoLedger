import { z } from 'zod';

/** Request schemas for Inventory's valuation, true-up, reclass, and link-all endpoints. */

export const valuationQuerySchema = z.object({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const trueUpSchema = z.object({
  accountId: z.string().uuid(),
  expectedDifferenceCents: z.number().int().refine((v) => v !== 0, 'expectedDifferenceCents must not be zero'),
});
