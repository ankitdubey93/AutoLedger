import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from '../../config/currencies.js';
import { QUOTE_MAX_LINES } from '../../config/constants.js';

/**
 * Request schemas for Phase 42 orders (sales and purchase).
 *
 * Deliberately absent: `direction` (it comes from the route — `/orders` or
 * `/purchase-orders` — never the body), `status`, `orderNumber` (allocated at
 * confirmation), every total, and the billed quantities (derived from the
 * invoice and bill lines that link to each order line, never stored).
 */

const orderLineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantityMilli: z.int().min(1).max(1_000_000_000),
  unitPriceCents: z.int().min(0).max(1_000_000_000_000),
  // Revenue for a sales order, Expense/Asset for a purchase order — the
  // service checks the type against the route's direction.
  accountId: z.uuid(),
  taxRateBp: z.int().min(0).max(10_000).default(0),
  itemId: z.uuid().nullable().default(null),
});

export const createOrderSchema = z
  .object({
    /** The customer (sales) or vendor (purchase). */
    partyId: z.uuid(),
    orderDate: z.iso.date(),
    expectedDate: z.iso.date().nullable().default(null),
    currencyCode: z.enum(SUPPORTED_CURRENCIES).optional(),
    partyReference: z.string().trim().max(100).nullable().default(null),
    notes: z.string().trim().max(1000).nullable().default(null),
    terms: z.string().trim().max(5000).nullable().default(null),
    paymentTerms: z.string().trim().max(500).nullable().default(null),
    paymentTermsCode: z.string().trim().max(30).nullable().default(null),
    lines: z.array(orderLineSchema).min(1, 'An order needs at least one line').max(QUOTE_MAX_LINES),
  })
  .refine((v) => v.expectedDate === null || v.expectedDate >= v.orderDate, {
    message: 'Expected date cannot be before the order date',
    path: ['expectedDate'],
  });

export const updateOrderSchema = createOrderSchema;

export const cancelOrderSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required').max(500),
});

export const convertOrderSchema = z.object({
  /** The invoice's issue date / bill's date. Omitted = the organization's today. */
  documentDate: z.iso.date().nullable().default(null),
  /** Omitted = from the order's payment term, else the default due days. */
  dueDate: z.iso.date().nullable().default(null),
  /** Purchase only — the vendor's own invoice number; omitted = `<order number>-<n>`. */
  vendorReference: z.string().trim().min(1).max(100).nullable().default(null),
  /** Omitted/null = everything still unbilled; otherwise the quantity to bill per order line. */
  lines: z
    .array(
      z.object({
        orderLineId: z.uuid(),
        quantityMilli: z.int().min(1).max(1_000_000_000),
      }),
    )
    .min(1)
    .nullable()
    .default(null),
});
