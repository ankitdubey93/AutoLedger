import { z } from 'zod';

/**
 * Request schemas for journal entries.
 *
 * This is the payload that justified adopting zod at all: a nested array with a
 * cross-field rule per element, which the hand-rolled `utils/validate.ts` covers
 * clumsily at best (docs/development.md#dependency-policy).
 *
 * Note what is absent: `sourceType` and `sourceId`. A client-posted entry is
 * always `'manual'`. Another app posting into the GL passes them
 * service-to-service through `journalService.createEntry`, never over HTTP —
 * otherwise any caller could forge a ledger entry that claims to have come from
 * AP-Flow (guardrails rule 16).
 */

const lineSchema = z
  .object({
    accountId: z.uuid(),
    // z.int() rejects 45000.5 and 1e21 alike. Money is integer cents at the
    // boundary too, not only in the database (guardrails rule 3).
    debitCents: z.int().nonnegative().default(0),
    creditCents: z.int().nonnegative().default(0),
  })
  .refine((line) => (line.debitCents > 0) !== (line.creditCents > 0), {
    message: 'A line must have exactly one of debitCents or creditCents greater than zero',
  });

export const createJournalSchema = z.object({
  entryDate: z.iso.date(),
  description: z.string().trim().max(500).nullable().default(null),
  // Two lines is the floor of double-entry: one line cannot balance against
  // anything. Also enforced by the deferred constraint trigger in 004.
  lines: z.array(lineSchema).min(2, 'An entry needs at least two lines'),
});

/** The reversal date is optional; omitted, the original's date is reused. */
export const reverseJournalSchema = z.object({
  entryDate: z.iso.date().nullable().default(null),
});
