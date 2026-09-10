import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from '../../config/currencies.js';

/**
 * Request schemas for LedgerCore payments.
 *
 * Deliberately absent: `direction`'s counterpart validation happens in the
 * top-level `.refine` below, `fxRate` (always resolved from `fx_rates`,
 * never client-supplied), `status` (a payment is born POSTED),
 * `journalEntryId` (the server posts it). A client-supplied total would be a
 * client-supplied lie.
 *
 * `currencyCode` (Phase 8) is optional — omitted means the organization's
 * base currency, the pre-Phase-8 behaviour. A payment may only allocate to
 * documents already in that same currency (enforced by the service and by
 * `trg_allocations_currency`, migration 025).
 */

const allocationSchema = z
  .object({
    invoiceId: z.uuid().nullable().default(null),
    billId: z.uuid().nullable().default(null),
    amountCents: z.int().min(1).max(1_000_000_000_000),
  })
  .refine((v) => (v.invoiceId === null) !== (v.billId === null), {
    message: 'An allocation targets exactly one invoice or one bill',
  });

export const createPaymentSchema = z
  .object({
    direction: z.enum(['RECEIVE', 'PAY']),
    paymentDate: z.iso.date(),
    amountCents: z.int().min(1).max(1_000_000_000_000),
    currencyCode: z.enum(SUPPORTED_CURRENCIES).optional(),
    cashAccountId: z.uuid(),
    customerId: z.uuid().nullable().default(null),
    vendorId: z.uuid().nullable().default(null),
    method: z.string().trim().max(40).nullable().default(null),
    reference: z.string().trim().max(100).nullable().default(null),
    notes: z.string().trim().max(1000).nullable().default(null),
    allocations: z.array(allocationSchema).min(1, 'A payment needs at least one allocation'),
    entryDate: z.iso.date().nullable().default(null),
  })
  .refine(
    (v) =>
      v.direction === 'RECEIVE'
        ? v.customerId !== null && v.vendorId === null
        : v.vendorId !== null && v.customerId === null,
    { message: 'A RECEIVE payment names a customer; a PAY payment names a vendor' },
  );

export const voidPaymentSchema = z.object({ entryDate: z.iso.date().nullable().default(null) });
