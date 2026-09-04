import { z } from 'zod';

/** Request schemas for LedgerCore vendors. */

export const createVendorSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.email().max(254).nullable().default(null),
  phone: z.string().trim().max(40).nullable().default(null),
  billingAddress: z.string().trim().max(500).nullable().default(null),
  taxNumber: z.string().trim().max(64).nullable().default(null),
  paymentTerms: z.string().trim().max(500).nullable().default(null),
  notes: z.string().trim().max(1000).nullable().default(null),
});

export const updateVendorSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    email: z.email().max(254).nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    billingAddress: z.string().trim().max(500).nullable().optional(),
    taxNumber: z.string().trim().max(64).nullable().optional(),
    paymentTerms: z.string().trim().max(500).nullable().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });
