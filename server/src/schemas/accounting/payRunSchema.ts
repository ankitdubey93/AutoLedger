import { z } from 'zod';

export const bankAccountDetailsSchema = z.object({
  bsb: z.string().trim().min(6).max(7),
  accountNumber: z.string().trim().min(1).max(12),
  accountName: z.string().trim().min(1).max(32),
  financialInstitution: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'The three-letter code your bank gave you, such as CBA'),
  apcaUserId: z.string().trim().regex(/^\d{6}$/, 'The six-digit user ID your bank gave you'),
  selfBalancing: z.boolean().default(false),
});

export const vendorBankDetailsSchema = z.object({
  bsb: z.string().trim().min(6).max(7),
  accountNumber: z.string().trim().min(1).max(12),
  accountName: z.string().trim().min(1).max(32),
});

export const createPaymentBatchSchema = z.object({
  bankAccountId: z.uuid(),
  paymentDate: z.iso.date(),
  description: z.string().trim().min(1).max(12),
  items: z
    .array(z.object({ billId: z.uuid(), amountCents: z.int().min(1).max(9_999_999_999) }))
    .min(1, 'Choose at least one expense')
    .max(500),
});
