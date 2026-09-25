import { z } from 'zod';
import {
  INVOICE_TEMPLATE_IDS,
  INVOICE_FONT_FAMILIES,
  INVOICE_DENSITIES,
} from '../../config/constants.js';

/** Request schema for Accounting invoice settings — numbering, defaults, branding. */
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
    templateId: z.enum(INVOICE_TEMPLATE_IDS).optional(),
    documentTitle: z.string().trim().min(1).max(24).optional(),
    fontFamily: z.enum(INVOICE_FONT_FAMILIES).optional(),
    density: z.enum(INVOICE_DENSITIES).optional(),
    showLogo: z.boolean().optional(),
    showOrgAddress: z.boolean().optional(),
    showPaymentTerms: z.boolean().optional(),
    showDueDate: z.boolean().optional(),
    bankDetails: z.string().trim().max(500).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });
