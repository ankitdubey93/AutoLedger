import { z } from 'zod';

/** Request schemas for LedgerCore payment terms. */

export const createPaymentTermSchema = z.object({
  code: z.string().trim().min(2).max(30).regex(/^[A-Za-z0-9_]+$/, 'Use only letters, digits and underscore'),
  name: z.string().trim().min(1).max(60),
  netDays: z.int().min(0).max(365),
});

export const updatePaymentTermSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    netDays: z.int().min(0).max(365).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });
