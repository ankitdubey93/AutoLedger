import { z } from 'zod';
import { INVOICE_TEMPLATE_IDS, STATEMENT_TYPES } from '../../config/constants.js';

/** PATCH /settings/statements (Phase 39a). */
export const updateStatementSettingsSchema = z
  .object({
    templateId: z.enum(INVOICE_TEMPLATE_IDS).optional(),
    documentTitle: z.string().trim().min(1).max(24).optional(),
    defaultType: z.enum(STATEMENT_TYPES).optional(),
    showLogo: z.boolean().optional(),
    showOrgAddress: z.boolean().optional(),
    showAgingSummary: z.boolean().optional(),
    showRemittance: z.boolean().optional(),
    footerNotes: z.string().trim().max(500).nullable().optional(),
    accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'accentColor must be a #rrggbb hex colour').optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });
