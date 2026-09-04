import { z } from 'zod';

/**
 * Request schemas for LedgerCore payments.
 *
 * Deliberately absent: `direction`'s counterpart validation happens in the
 * top-level `.refine` below, `currencyCode` (the organization's base
 * currency), `status` (a payment is born POSTED), `journalEntryId` (the
 * server posts it). A client-supplied total would be a client-supplied lie.
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
