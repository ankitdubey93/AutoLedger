import { z } from 'zod';

/**
 * Request schemas for LedgerCore bills.
 *
 * Deliberately absent: `status`, `currencyCode`, `subtotalCents`, `taxCents`,
 * `totalCents`, `journalEntryId`, `approvedBy`. Status moves only through
 * `/submit`, `/approve` and `/void`; the currency is the organization's base
 * currency; the totals are computed from the lines. A client-supplied total
 * would be a client-supplied lie.
 */

const billLineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantityMilli: z.int().min(1).max(1_000_000_000),
  unitPriceCents: z.int().min(0).max(1_000_000_000_000),
  expenseAccountId: z.uuid(),
  taxRateBp: z.int().min(0).max(10_000).default(0),
});

export const createBillSchema = z.object({
  vendorId: z.uuid(),
  vendorReference: z.string().trim().min(1).max(100),
  billDate: z.iso.date(),
  dueDate: z.iso.date(),
  notes: z.string().trim().max(1000).nullable().default(null),
  paymentTerms: z.string().trim().max(500).nullable().default(null),
  lines: z.array(billLineSchema).min(1, 'A bill needs at least one line'),
});

export const updateBillSchema = createBillSchema;

export const submitBillSchema = z.object({});
export const approveBillSchema = z.object({ entryDate: z.iso.date().nullable().default(null) });
export const voidBillSchema = z.object({ entryDate: z.iso.date().nullable().default(null) });
