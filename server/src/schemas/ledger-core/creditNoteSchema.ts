import { z } from 'zod';
import { NOTE_REASON_CODES } from '../../types/ledger-core.js';

/**
 * Request schemas for LedgerCore credit notes (Phase 26).
 *
 * Deliberately absent: `customerId`, `currencyCode`, `fxRate`, `status`,
 * `creditNoteNumber`, and every total. The customer, currency and rate are
 * copied from the original invoice server-side; status moves only through
 * `/issue` and `/void`; the number is allocated at issue; totals are computed
 * from the lines.
 */

const creditNoteLineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantityMilli: z.int().min(1).max(1_000_000_000),
  unitPriceCents: z.int().min(0).max(1_000_000_000_000),
  revenueAccountId: z.uuid(),
  taxRateBp: z.int().min(0).max(10_000).default(0),
});

export const createCreditNoteSchema = z.object({
  invoiceId: z.uuid(),
  issueDate: z.iso.date(),
  reasonCode: z.enum(NOTE_REASON_CODES),
  reason: z.string().trim().max(500).nullable().default(null),
  notes: z.string().trim().max(1000).nullable().default(null),
  lines: z.array(creditNoteLineSchema).min(1, 'A credit note needs at least one line'),
});

export const updateCreditNoteSchema = createCreditNoteSchema;

export const issueCreditNoteSchema = z.object({ entryDate: z.iso.date().nullable().default(null) });
export const voidCreditNoteSchema = z.object({ entryDate: z.iso.date().nullable().default(null) });

export const applyCreditNoteSchema = z.object({
  invoiceId: z.uuid(),
  amountCents: z.int().min(1).max(1_000_000_000_000),
  allocationDate: z.iso.date(),
});
