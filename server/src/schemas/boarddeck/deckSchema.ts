import { z } from 'zod';

export const createDeckSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    fiscalPeriodId: z.uuid(),
    planId: z.uuid().nullable().default(null),
  })
  .strict();
