import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from '../../config/currencies.js';

/**
 * Request schemas for LedgerCore bills.
 *
 * Deliberately absent: `status`, `fxRate`, `subtotalCents`, `taxCents`,
 * `totalCents`, `journalEntryId`, `approvedBy`. Status moves only through
 * `/submit`, `/approve` and `/void`; the rate is always resolved from
 * `fx_rates`, never client-supplied; the totals are computed from the lines.
 * A client-supplied total would be a client-supplied lie.
 *
 * `currencyCode` (Phase 8) is optional — omitted means the organization's
 * base currency, the pre-Phase-8 behaviour.
 */

// itemId (Phase 24) records which catalogue item a line was picked from — the
// line's own description/unitPriceCents/account/taxRateBp are still taken
// exactly as sent; picking an item only copies its defaults into those
// fields client-side, once. This schema never reads the item.
const billLineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantityMilli: z.int().min(1).max(1_000_000_000),
  unitPriceCents: z.int().min(0).max(1_000_000_000_000),
  expenseAccountId: z.uuid(),
  taxRateBp: z.int().min(0).max(10_000).default(0),
  itemId: z.uuid().nullable().default(null),
});

export const createBillSchema = z
  .object({
    vendorId: z.uuid(),
    vendorReference: z.string().trim().min(1).max(100),
    billDate: z.iso.date(),
    // Phase 24 — either an explicit dueDate or a paymentTermsCode is required;
    // an explicit date always wins (billService.resolveBillDueDate).
    dueDate: z.iso.date().optional(),
    currencyCode: z.enum(SUPPORTED_CURRENCIES).optional(),
    notes: z.string().trim().max(1000).nullable().default(null),
    paymentTerms: z.string().trim().max(500).nullable().default(null),
    paymentTermsCode: z.string().trim().max(30).nullable().default(null),
    lines: z.array(billLineSchema).min(1, 'A bill needs at least one line'),
  })
  .refine((v) => v.dueDate !== undefined || v.paymentTermsCode !== null, {
    message: 'Provide a due date or a payment term',
  });

export const updateBillSchema = createBillSchema;

export const submitBillSchema = z.object({});
export const approveBillSchema = z.object({ entryDate: z.iso.date().nullable().default(null) });
export const voidBillSchema = z.object({ entryDate: z.iso.date().nullable().default(null) });
