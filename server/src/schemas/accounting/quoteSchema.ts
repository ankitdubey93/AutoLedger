import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from '../../config/currencies.js';
import { QUOTE_MAX_LINES } from '../../config/constants.js';

/**
 * Request schemas for Phase 41 quotes (sales and purchase).
 *
 * Deliberately absent: `direction` (it comes from the route — `/quotes` or
 * `/purchase-quotes` — never the body), `status`, `quoteNumber`, `revision`,
 * every total, the indicative rate and the content hash. Status moves only
 * through the action routes; the number is allocated at send; totals are
 * computed from the lines; the hash is computed from the frozen content.
 */

const quoteLineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantityMilli: z.int().min(1).max(1_000_000_000),
  unitPriceCents: z.int().min(0).max(1_000_000_000_000),
  // Revenue for a sales quote, Expense/Asset for a purchase quote — the
  // service checks the type against the route's direction.
  accountId: z.uuid(),
  taxRateBp: z.int().min(0).max(10_000).default(0),
  itemId: z.uuid().nullable().default(null),
});

export const createQuoteSchema = z
  .object({
    /** The customer (sales) or vendor (purchase). */
    partyId: z.uuid(),
    quoteDate: z.iso.date(),
    /** Omitted = quoteDate + the organization's default validity. */
    validUntil: z.iso.date().optional(),
    currencyCode: z.enum(SUPPORTED_CURRENCIES).optional(),
    partyReference: z.string().trim().max(100).nullable().default(null),
    title: z.string().trim().max(200).nullable().default(null),
    notes: z.string().trim().max(1000).nullable().default(null),
    /** Omitted = the organization's default quote terms. */
    terms: z.string().trim().max(5000).nullable().optional(),
    paymentTerms: z.string().trim().max(500).nullable().default(null),
    paymentTermsCode: z.string().trim().max(30).nullable().default(null),
    /** Phase 42 — deposit asked for on acceptance, in basis points of the total; null = none. */
    depositPercentBp: z.int().min(1).max(10_000).nullable().default(null),
    lines: z.array(quoteLineSchema).min(1, 'A quote needs at least one line').max(QUOTE_MAX_LINES),
  })
  .refine((v) => v.validUntil === undefined || v.validUntil >= v.quoteDate, {
    message: 'Valid until cannot be before the quote date',
    path: ['validUntil'],
  });

export const updateQuoteSchema = createQuoteSchema;

export const sendQuoteSchema = z
  .object({
    /** EMAIL sends a review link; MANUAL only finalizes (number + freeze) for printing. */
    delivery: z.enum(['EMAIL', 'MANUAL']),
    toEmail: z.email().trim().toLowerCase().max(254).nullable().default(null),
    message: z.string().trim().max(2000).nullable().default(null),
    templateId: z.uuid().nullable().default(null),
  })
  .refine((v) => v.delivery === 'MANUAL' || v.toEmail !== null, {
    message: 'An email address is required to email a quote',
    path: ['toEmail'],
  });

export const recordAcceptanceSchema = z.object({
  signerName: z.string().trim().min(1).max(200),
  note: z.string().trim().max(1000).nullable().default(null),
});

export const recordDeclineSchema = z.object({
  reason: z.string().trim().max(1000).nullable().default(null),
  note: z.string().trim().max(1000).nullable().default(null),
});

export const voidQuoteSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required').max(500),
});

export const convertQuoteSchema = z.object({
  /** The invoice's issue date / bill's date. Omitted = today. */
  documentDate: z.iso.date().nullable().default(null),
  /** Omitted = from the quote's payment term, else the default due days. */
  dueDate: z.iso.date().nullable().default(null),
  /** Purchase only — the vendor's own invoice number for the bill. */
  vendorReference: z.string().trim().min(1).max(100).nullable().default(null),
  /**
   * Phase 42 — INVOICE (default; a DRAFT invoice/bill as before) or ORDER (a
   * confirmed sales/purchase order the quote's lines are then billed against,
   * in parts). Date/reference fields apply to INVOICE only.
   */
  target: z.enum(['INVOICE', 'ORDER']).default('INVOICE'),
});

// ------------------------------------------------------------- public page

export const publicAcceptQuoteSchema = z.object({
  signerName: z.string().trim().min(1, 'Type your full name to accept').max(200),
  signerEmail: z.email().trim().toLowerCase().max(254).nullable().default(null),
  acceptTerms: z.literal(true, { error: 'You must accept the terms to accept this quote' }),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** The 6-digit code emailed to signerEmail (Phase 42 D); required when the org turns verification on. */
  code: z.string().regex(/^\d{6}$/).nullable().default(null),
});

export const publicVerifyEmailSchema = z.object({
  signerEmail: z.email().trim().toLowerCase().max(254),
});

export const publicDeclineQuoteSchema = z.object({
  reason: z.string().trim().max(1000).nullable().default(null),
});
