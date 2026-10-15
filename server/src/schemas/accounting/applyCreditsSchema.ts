import { z } from 'zod';

/**
 * Phase 43c — credits applied atomically with a bill's approval or an
 * invoice's issue. Shared by `approveBillSchema` and `issueInvoiceSchema`.
 * A credit may be listed once; the services re-check every business rule.
 */
export const applyCreditsSchema = z
  .array(
    z.object({
      kind: z.enum(['NOTE', 'DEPOSIT']),
      id: z.uuid(),
      amountCents: z.int().positive(),
    }),
  )
  .max(20)
  .default([])
  .refine((credits) => new Set(credits.map((c) => c.id)).size === credits.length, {
    message: 'Each credit can be listed once',
  });
