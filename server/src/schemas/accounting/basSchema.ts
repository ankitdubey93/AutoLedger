import { z } from 'zod';

export const createBasSchema = z.object({ periodStart: z.iso.date() });

const CENTS_MAX = 1_000_000_000_000;

export const updateBasSchema = z
  .object({
    w1Cents: z.int().min(0).max(CENTS_MAX).optional(),
    w2Cents: z.int().min(0).max(CENTS_MAX).optional(),
    instalmentCents: z.int().min(0).max(CENTS_MAX).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export const addBasAdjustmentSchema = z.object({
  label: z.enum(['G7', 'G18']),
  grossCents: z.int().min(-CENTS_MAX).max(CENTS_MAX).refine((v) => v !== 0, { message: 'An adjustment needs an amount' }),
  accountId: z.uuid(),
  reason: z.string().trim().min(1, 'A reason is required').max(500),
});

export const lodgeBasSchema = z.object({
  lodgedOn: z.iso.date(),
  atoReference: z.string().trim().max(100).nullable().default(null),
});
