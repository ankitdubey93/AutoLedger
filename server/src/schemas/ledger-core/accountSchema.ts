import { z } from 'zod';
import { ACCOUNT_TYPES } from '../../types/ledger-core.js';

/**
 * Request schemas for the chart of accounts.
 *
 * `z.enum(ACCOUNT_TYPES)` reuses the same `as const` array that derives the
 * `AccountType` union and mirrors the migration's CHECK constraint — one list,
 * three enforcement points, no way for them to drift apart (guardrails rule 12).
 */

export const createAccountSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(120),
  type: z.enum(ACCOUNT_TYPES),
  parentId: z.uuid().nullable().default(null),
  isPostable: z.boolean().default(true),
  description: z.string().trim().max(500).nullable().default(null),
});

/**
 * `code` and `type` are absent by design, not by oversight.
 *
 * Reports derive meaning from the code ranges (docs/schema.md), and re-typing an
 * account that already has postings would silently restate every prior period.
 * Retire an account with `isActive: false` and create a replacement.
 */
export const updateAccountSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    isActive: z.boolean().optional(),
    parentId: z.uuid().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'No fields to update',
  });
