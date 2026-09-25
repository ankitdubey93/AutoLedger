import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from '../../config/currencies.js';

/**
 * Request schemas for Accounting sales invoices.
 *
 * Deliberately absent: `status`, `invoiceNumber`, `fxRate`, `subtotalCents`,
 * `taxCents`, `totalCents`, `journalEntryId`. Status moves only through
 * `/issue` and `/void`; the number is allocated server-side; the rate is
 * always resolved from `fx_rates`, never client-supplied; the totals are
 * computed from the lines. A client-supplied total would be a client-supplied
 * lie.
 *
 * `currencyCode` (Phase 8) is optional — omitted means the organization's
 * base currency, the pre-Phase-8 behaviour.
 */

// itemId (Phase 24) records which catalogue item a line was picked from — the
// line's own description/unitPriceCents/account/taxRateBp are still taken
// exactly as sent; picking an item only copies its defaults into those
// fields client-side, once. This schema never reads the item.
const invoiceLineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantityMilli: z.int().min(1).max(1_000_000_000),
  unitPriceCents: z.int().min(0).max(1_000_000_000_000),
  revenueAccountId: z.uuid(),
  taxRateBp: z.int().min(0).max(10_000).default(0),
  itemId: z.uuid().nullable().default(null),
  // Phase 32: where an INVENTORY line moves stock. Null = Inventory's default location.
  stockLocationId: z.uuid().nullable().default(null),
});

export const createInvoiceSchema = z
  .object({
    customerId: z.uuid(),
    issueDate: z.iso.date(),
    // Phase 24 — either an explicit dueDate or a paymentTermsCode is required;
    // an explicit date always wins (invoiceService.resolveInvoiceDueDate).
    dueDate: z.iso.date().optional(),
    currencyCode: z.enum(SUPPORTED_CURRENCIES).optional(),
    notes: z.string().trim().max(1000).nullable().default(null),
    paymentTerms: z.string().trim().max(500).nullable().default(null),
    paymentTermsCode: z.string().trim().max(30).nullable().default(null),
    lines: z.array(invoiceLineSchema).min(1, 'An invoice needs at least one line'),
  })
  .refine((v) => v.dueDate !== undefined || v.paymentTermsCode !== null, {
    message: 'Provide a due date or a payment term',
  });

export const updateInvoiceSchema = createInvoiceSchema;

export const issueInvoiceSchema = z.object({ entryDate: z.iso.date().nullable().default(null) });
export const voidInvoiceSchema = z.object({ entryDate: z.iso.date().nullable().default(null) });
