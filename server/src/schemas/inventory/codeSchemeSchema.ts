import { z } from 'zod';

/**
 * Request schemas for Inventory's item-code schemes. `pattern` is
 * deliberately NOT in `updateCodeSchemeSchema` — it is not updatable, and
 * parsing/validating a pattern happens in `codeSchemeService`, so the 422
 * message stays specific rather than a generic zod complaint.
 */

export const createCodeSchemeSchema = z.object({
  name: z.string().trim().min(1).max(80),
  pattern: z.string().min(1).max(60),
  isDefault: z.boolean().default(false),
});

export const updateCodeSchemeSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    isDefault: z.literal(true).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

export const previewPatternSchema = z.object({
  pattern: z.string().min(1).max(60),
  categoryId: z.uuid().nullable().default(null),
  attributes: z.record(z.string(), z.union([z.string(), z.boolean()])).default({}),
});
