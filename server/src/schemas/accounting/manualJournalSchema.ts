import { z } from 'zod';

/**
 * Request schemas for manual journals (Phase 44).
 *
 * Like journalSchema.ts, this takes no `sourceType` or `sourceId`: a manual
 * journal is always `'manual'` on the GL side. Recurring and import paths
 * create manual journals service-to-service, never over HTTP.
 *
 * A line may be half-typed on a draft (no account, both sides zero). The
 * "exactly one side" rule (guardrails rule 7) is enforced when the journal is
 * posted, by the service and by the ledger_lines CHECK constraints.
 */

const lineSchema = z
  .object({
    accountId: z.uuid().nullable().default(null),
    description: z.string().trim().max(500).nullable().default(null),
    // z.int() rejects 45000.5 and 1e21 alike. Money is integer cents at the
    // boundary too (guardrails rule 3).
    debitCents: z.int().nonnegative().default(0),
    creditCents: z.int().nonnegative().default(0),
  })
  .refine((l) => !(l.debitCents > 0 && l.creditCents > 0), {
    message: 'A line cannot have both a debit and a credit',
  });

export const manualJournalBodySchema = z.object({
  narration: z.string().trim().min(1, 'Narration is required').max(500),
  entryDate: z.iso.date(),
  lines: z.array(lineSchema).min(1).max(200),
});

export const createManualJournalSchema = manualJournalBodySchema.extend({
  action: z.enum(['draft', 'post']),
});

/** The void date is optional; omitted or null, the original's date is reused. */
export const voidManualJournalSchema = z.object({
  voidDate: z.iso.date().nullable().default(null),
});

export const createRepeatingJournalSchema = manualJournalBodySchema
  .extend({
    name: z.string().trim().min(1).max(80),
    frequency: z.enum(['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']),
    intervalCount: z.int().min(1).max(12).default(1),
    startDate: z.iso.date(),
    endDate: z.iso.date().nullable().default(null),
    autoReverse: z.boolean().default(false),
  })
  .refine((v) => v.endDate === null || v.endDate >= v.startDate, {
    message: 'endDate must not be before startDate',
  });

export const listManualJournalsQuerySchema = z.object({
  status: z.enum(['all', 'draft', 'posted', 'voided']).default('all'),
});
