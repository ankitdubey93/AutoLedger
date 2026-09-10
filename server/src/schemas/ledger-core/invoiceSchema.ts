import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from '../../config/currencies.js';

/**
 * Request schemas for LedgerCore sales invoices.
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

const invoiceLineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantityMilli: z.int().min(1).max(1_000_000_000),
  unitPriceCents: z.int().min(0).max(1_000_000_000_000),
  revenueAccountId: z.uuid(),
  taxRateBp: z.int().min(0).max(10_000).default(0),
});

export const createInvoiceSchema = z.object({
  customerId: z.uuid(),
  issueDate: z.iso.date(),
  dueDate: z.iso.date(),
  currencyCode: z.enum(SUPPORTED_CURRENCIES).optional(),
  notes: z.string().trim().max(1000).nullable().default(null),
  paymentTerms: z.string().trim().max(500).nullable().default(null),
  lines: z.array(invoiceLineSchema).min(1, 'An invoice needs at least one line'),
});

export const updateInvoiceSchema = createInvoiceSchema;

export const issueInvoiceSchema = z.object({ entryDate: z.iso.date().nullable().default(null) });
export const voidInvoiceSchema = z.object({ entryDate: z.iso.date().nullable().default(null) });
