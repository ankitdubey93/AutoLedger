import { z } from 'zod';
import { NOTE_REASON_CODES } from '../../types/accounting.js';

/**
 * Request schemas for Accounting debit notes (Phase 26) — the purchase-side
 * mirror of creditNoteSchema.ts.
 *
 * Deliberately absent: `vendorId`, `currencyCode`, `fxRate`, `status`,
 * `debitNoteNumber`, and every total — all derived server-side from the
 * original bill and the lines.
 */

const debitNoteLineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantityMilli: z.int().min(1).max(1_000_000_000),
  unitPriceCents: z.int().min(0).max(1_000_000_000_000),
  expenseAccountId: z.uuid(),
  taxRateBp: z.int().min(0).max(10_000).default(0),
});

export const createDebitNoteSchema = z.object({
  billId: z.uuid(),
  issueDate: z.iso.date(),
  reasonCode: z.enum(NOTE_REASON_CODES),
  reason: z.string().trim().max(500).nullable().default(null),
  vendorCreditReference: z.string().trim().max(100).nullable().default(null),
  notes: z.string().trim().max(1000).nullable().default(null),
  lines: z.array(debitNoteLineSchema).min(1, 'A debit note needs at least one line'),
});

export const updateDebitNoteSchema = createDebitNoteSchema;

export const issueDebitNoteSchema = z.object({ entryDate: z.iso.date().nullable().default(null) });
export const voidDebitNoteSchema = z.object({ entryDate: z.iso.date().nullable().default(null) });

export const applyDebitNoteSchema = z.object({
  billId: z.uuid(),
  amountCents: z.int().min(1).max(1_000_000_000_000),
  allocationDate: z.iso.date(),
});
