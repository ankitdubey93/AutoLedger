import { z } from 'zod';

/** Phase 42 Slice C — quote email templates and the send-dialog preview. */

export const createQuoteTemplateSchema = z.object({
  direction: z.enum(['SALES', 'PURCHASE']),
  name: z.string().trim().min(1).max(100),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
  isDefault: z.boolean().default(false),
});

export const updateQuoteTemplateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  subject: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(1).max(5000).optional(),
  isDefault: z.boolean().optional(),
});

export const previewQuoteEmailSchema = z.object({
  templateId: z.uuid().nullable().default(null),
});
