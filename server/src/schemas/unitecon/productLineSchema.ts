import { z } from 'zod';

export const createProductLineSchema = z.object({
  revenueAccountId: z.string().uuid('revenueAccountId must be a UUID'),
  name: z.string().trim().min(1, 'name is required').max(120),
  unitLabel: z.string().trim().max(40).default(''),
});

/**
 * `revenueAccountId` is absent deliberately — repointing a product line at a
 * different account would silently rewrite every historical PVM report it
 * appears in. To change the account, delete the line and create a new one.
 */
export const updateProductLineSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    unitLabel: z.string().trim().max(40),
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');
