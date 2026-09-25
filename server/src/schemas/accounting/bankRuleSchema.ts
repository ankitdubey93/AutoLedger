import { z } from 'zod';

/** Request schemas for Accounting bank rules. */

export const createBankRuleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  priority: z.int().min(0).max(10000).default(100),
  direction: z.enum(['IN', 'OUT', 'ANY']).default('ANY'),
  memoContains: z.string().trim().min(1).max(100),
  amountMinCents: z.int().positive().nullable().default(null),
  amountMaxCents: z.int().positive().nullable().default(null),
  bankAccountId: z.uuid().nullable().default(null),
  targetAccountId: z.uuid(),
  description: z.string().trim().min(1).max(200).nullable().default(null),
}).refine((v) => v.amountMinCents === null || v.amountMaxCents === null || v.amountMinCents <= v.amountMaxCents,
  { message: 'amountMinCents must not exceed amountMaxCents' });

export const updateBankRuleSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  priority: z.int().min(0).max(10000).optional(),
  direction: z.enum(['IN', 'OUT', 'ANY']).optional(),
  memoContains: z.string().trim().min(1).max(100).optional(),
  amountMinCents: z.int().positive().nullable().optional(),
  amountMaxCents: z.int().positive().nullable().optional(),
  bankAccountId: z.uuid().nullable().optional(),
  targetAccountId: z.uuid().optional(),
  description: z.string().trim().min(1).max(200).nullable().optional(),
  isActive: z.boolean().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });
