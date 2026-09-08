import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from '../../config/currencies.js';

/**
 * Request schemas for LedgerCore onboarding and settings.
 *
 * `organizationName` and `baseCurrency` appear only on `onboardingSchema` —
 * after onboarding they are edited through `PATCH /organizations` instead,
 * because they are platform fields (docs/architecture.md), not LedgerCore
 * ones. `updateSettingsSchema` does not carry them.
 */

export const onboardingSchema = z.object({
  organizationName: z.string().trim().min(2).max(120),
  legalName: z.string().trim().max(200).nullable().default(null),
  baseCurrency: z.enum(SUPPORTED_CURRENCIES),
  fiscalYearStartMonth: z.int().min(1).max(12),
  fiscalYearStartDay: z.int().min(1).max(28).default(1),
  booksStartDate: z.iso.date(),
  industry: z.string().trim().max(80).nullable().default(null),
  timezone: z.string().trim().max(64).default('UTC'),
  cashAccountId: z.uuid().nullable().default(null),
});

export const updateSettingsSchema = z
  .object({
    legalName: z.string().trim().max(200).nullable().optional(),
    fiscalYearStartMonth: z.int().min(1).max(12).optional(),
    fiscalYearStartDay: z.int().min(1).max(28).optional(),
    booksStartDate: z.iso.date().optional(),
    industry: z.string().trim().max(80).nullable().optional(),
    timezone: z.string().trim().max(64).optional(),
    cashAccountId: z.uuid().nullable().optional(),
    unmatchedAlertThresholdCents: z.int().min(0).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'No fields to update',
  });
