import { z } from 'zod';
import { PAYMENT_TERM_RULES } from '../../types/accounting.js';

/** Request schemas for Accounting payment terms. */

export const createPaymentTermSchema = z.object({
  code: z.string().trim().min(2).max(30).regex(/^[A-Za-z0-9_]+$/, 'Use only letters, digits and underscore'),
  name: z.string().trim().min(1).max(60),
  netDays: z.int().min(0).max(365),
  rule: z.enum(PAYMENT_TERM_RULES).default('DAYS_AFTER_DATE'),
}).superRefine((value, ctx) => {
  if (value.rule.startsWith('DAY_OF_') && (value.netDays < 1 || value.netDays > 31)) {
    ctx.addIssue({ code: 'custom', path: ['netDays'], message: 'Day of month must be between 1 and 31' });
  }
});

export const updatePaymentTermSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    netDays: z.int().min(0).max(365).optional(),
    rule: z.enum(PAYMENT_TERM_RULES).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });
