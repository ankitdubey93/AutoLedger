import { z } from 'zod';

/** Request schema for LedgerCore invoice settings — numbering, defaults, branding. */
export const updateInvoiceSettingsSchema = z
  .object({
    numberPrefix: z.string().trim().max(12).optional(),
    numberPadding: z.int().min(1).max(12).optional(),
    nextNumber: z.int().min(1).max(9_999_999).optional(),
    defaultDueDays: z.int().min(0).max(365).optional(),
    defaultTaxRateBp: z.int().min(0).max(10_000).optional(),
    taxLabel: z.string().trim().min(1).max(24).optional(),
    receivableAccountId: z.uuid().nullable().optional(),
    defaultRevenueAccountId: z.uuid().nullable().optional(),
    taxPayableAccountId: z.uuid().nullable().optional(),
    showTaxNumber: z.boolean().optional(),
    showBusinessNumber: z.boolean().optional(),
    showLegalName: z.boolean().optional(),
    billingAddress: z.string().trim().max(500).nullable().optional(),
    paymentTerms: z.string().trim().max(500).nullable().optional(),
    footerNotes: z.string().trim().max(500).nullable().optional(),
    accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'accentColor must be a #rrggbb hex colour').optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });
