import { z } from 'zod';

/** Phase 42 — body of `POST /orders/:id/deposit` and `/purchase-orders/:id/deposit`: exactly one of percentBp or amountCents. */
export const createDepositSchema = z
  .object({
    percentBp: z.int().min(1).max(10_000).nullable().default(null),
    amountCents: z.int().min(1).max(1_000_000_000_000).nullable().default(null),
    documentDate: z.iso.date().nullable().default(null),
    dueDate: z.iso.date().nullable().default(null),
    vendorReference: z.string().trim().min(1).max(100).nullable().default(null),
  })
  .refine((v) => (v.percentBp === null) !== (v.amountCents === null), { message: 'Give a percentage or an amount' });

/** Body of `POST /invoices/:id/apply-deposit` and `/bills/:id/apply-prepayment`. */
export const applyDepositSchema = z.object({
  depositDocumentId: z.uuid(),
  amountCents: z.int().min(1).max(1_000_000_000_000),
  applicationDate: z.iso.date(),
});

/** Body of the two void routes. */
export const voidDepositApplicationSchema = z.object({
  entryDate: z.iso.date().nullable().default(null),
});

export type CreateDepositBody = z.infer<typeof createDepositSchema>;
export type ApplyDepositBody = z.infer<typeof applyDepositSchema>;
