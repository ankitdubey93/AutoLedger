import { z } from 'zod';

/** Request schemas for Accounting recurring schedules. */

export const createRecurringScheduleSchema = z
  .object({
    kind: z.enum(['INVOICE', 'BILL', 'JOURNAL']),
    sourceId: z.uuid(),
    name: z.string().trim().min(1).max(80),
    frequency: z.enum(['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']),
    intervalCount: z.int().min(1).max(12).default(1),
    startDate: z.string().date(),
    endDate: z.string().date().nullable().default(null),
    mode: z.enum(['DRAFT', 'POST']).default('DRAFT'),
    autoReverse: z.boolean().default(false),
  })
  .refine((v) => v.endDate === null || v.endDate >= v.startDate, {
    message: 'endDate must not be before startDate',
  });

export const listRecurringSchedulesQuerySchema = z.object({
  kind: z.enum(['INVOICE', 'BILL', 'JOURNAL']).optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'ENDED']).optional(),
});
