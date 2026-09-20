import { z } from 'zod';

/** Request schemas for LedgerCore items. `code` and `kind` are not updatable. */

export const createItemSchema = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(500).nullable().default(null),
  kind: z.enum(['SERVICE', 'GOODS']),
  salePriceCents: z.int().min(0).max(1_000_000_000_000).nullable().default(null),
  purchasePriceCents: z.int().min(0).max(1_000_000_000_000).nullable().default(null),
  revenueAccountId: z.uuid().nullable().default(null),
  expenseAccountId: z.uuid().nullable().default(null),
  saleTaxRateBp: z.int().min(0).max(10_000).default(0),
  purchaseTaxRateBp: z.int().min(0).max(10_000).default(0),
});

export const updateItemSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    salePriceCents: z.int().min(0).max(1_000_000_000_000).nullable().optional(),
    purchasePriceCents: z.int().min(0).max(1_000_000_000_000).nullable().optional(),
    revenueAccountId: z.uuid().nullable().optional(),
    expenseAccountId: z.uuid().nullable().optional(),
    saleTaxRateBp: z.int().min(0).max(10_000).optional(),
    purchaseTaxRateBp: z.int().min(0).max(10_000).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });
