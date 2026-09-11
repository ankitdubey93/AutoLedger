import { z } from 'zod';

const FIRST_OF_MONTH = /^\d{4}-\d{2}-01$/;

export const createBudgetVersionSchema = z.object({
  label: z.string().trim().min(1, 'label is required').max(120),
});

/**
 * `source` is absent from this schema deliberately — a line created through
 * the API is always `'MANUAL'`. `'DRIVER'` and `'HEADCOUNT'` are written
 * only by `budgetService.compileVersion`, which is what makes "compile
 * replaces the generated lines and preserves the hand-entered ones"
 * expressible.
 */
export const createBudgetLineSchema = z.object({
  accountId: z.string().uuid(),
  month: z.string().regex(FIRST_OF_MONTH, 'month must be the first of a month (YYYY-MM-01)'),
  amountCents: z.number().int(),
  justification: z.string().trim().min(1, 'justification is required').max(1000),
});

export const updateBudgetLineSchema = z
  .object({
    amountCents: z.number().int(),
    justification: z.string().trim().min(1).max(1000),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');
