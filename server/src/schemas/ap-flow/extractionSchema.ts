import { z } from 'zod';

/**
 * The shape of the `record_invoice` tool's `input`, as the model returns it
 * — money fields are decimal STRINGS ("450.00"), never numbers, so nothing
 * here or downstream ever multiplies a float by 100 (guardrails rule 3).
 * The model's output is untrusted input and is parsed exactly like a
 * request body, never spread into a query.
 */
export const extractionLineItemSchema = z.object({
  description: z.string(),
  amount: z.string(),
});

export const extractionToolInputSchema = z.object({
  vendor_name: z.string().nullable().optional(),
  invoice_number: z.string().nullable().optional(),
  invoice_date: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  subtotal: z.string().nullable().optional(),
  tax: z.string().nullable().optional(),
  total: z.string().nullable().optional(),
  line_items: z.array(extractionLineItemSchema).default([]),
  field_confidence: z.record(z.string(), z.unknown()).default({}),
});

export type ExtractionToolInput = z.infer<typeof extractionToolInputSchema>;
