import { z } from 'zod';

const FIRST_OF_MONTH = /^\d{4}-\d{2}-01$/;

export const createHeadcountRoleSchema = z.object({
  title: z.string().trim().min(1, 'title is required').max(120),
  department: z.string().trim().max(120).nullable().default(null),
  accountId: z.string().uuid(),
  startsOn: z.string().regex(FIRST_OF_MONTH, 'startsOn must be the first of a month (YYYY-MM-01)'),
  endsOn: z
    .string()
    .regex(FIRST_OF_MONTH, 'endsOn must be the first of a month (YYYY-MM-01)')
    .nullable()
    .default(null),
  fteCount: z.number().int().min(1).max(1000).default(1),
  annualSalaryCents: z.number().int().min(0),
  loadingBps: z.number().int().min(0).max(10000).default(0),
});

export const updateHeadcountRoleSchema = createHeadcountRoleSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');
