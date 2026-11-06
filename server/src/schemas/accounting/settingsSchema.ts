import { z } from 'zod';
import { isValidTimeZone } from '../../utils/orgDate.js';
import { SUPPORTED_CURRENCIES } from '../../config/currencies.js';
import { AU_BASE_CURRENCY, AU_TIME_ZONES } from '../../config/taxPacks/au.js';
import { gstSettingsSchema } from './regionSchema.js';

/**
 * Request schemas for Accounting onboarding and settings.
 *
 * `organizationName` and `baseCurrency` appear only on `onboardingSchema` —
 * after onboarding they are edited through `PATCH /organizations` instead,
 * because they are platform fields (docs/architecture.md), not Accounting
 * ones. `updateSettingsSchema` does not carry them.
 */

export const onboardingSchema = z
  .object({
  organizationName: z.string().trim().min(2).max(120),
  legalName: z.string().trim().max(200).nullable().default(null),
  baseCurrency: z.enum(SUPPORTED_CURRENCIES),
  fiscalYearStartMonth: z.int().min(1).max(12),
  fiscalYearStartDay: z.int().min(1).max(28).default(1),
  booksStartDate: z.iso.date(),
  industry: z.string().trim().max(80).nullable().default(null),
  timezone: z.string().trim().max(64).refine(isValidTimeZone, { message: 'Unknown time zone' }).default('UTC'),
  cashAccountId: z.uuid().nullable().default(null),
  // Phase 49a — present only when the wizard's country step chose Australia.
  australia: z.object({ gst: gstSettingsSchema }).optional(),
  })
  .refine((value) => value.australia === undefined || value.baseCurrency === AU_BASE_CURRENCY, {
    message: `An Australian organization reports in ${AU_BASE_CURRENCY}`,
    path: ['baseCurrency'],
  })
  .refine(
    (value) => value.australia === undefined || (AU_TIME_ZONES as readonly string[]).includes(value.timezone),
    { message: 'Choose an Australian time zone', path: ['timezone'] },
  );

export const updateSettingsSchema = z
  .object({
    legalName: z.string().trim().max(200).nullable().optional(),
    fiscalYearStartMonth: z.int().min(1).max(12).optional(),
    fiscalYearStartDay: z.int().min(1).max(28).optional(),
    booksStartDate: z.iso.date().optional(),
    industry: z.string().trim().max(80).nullable().optional(),
    timezone: z.string().trim().max(64).refine(isValidTimeZone, { message: 'Unknown time zone' }).optional(),
    cashAccountId: z.uuid().nullable().optional(),
    unmatchedAlertThresholdCents: z.int().min(0).optional(),
    realizedFxGainAccountId: z.uuid().nullable().optional(),
    realizedFxLossAccountId: z.uuid().nullable().optional(),
    unrealizedFxAccountId: z.uuid().nullable().optional(),
    // Phase 35a — the four inventory posting accounts.
    inventoryAccountId: z.uuid().nullable().optional(),
    cogsAccountId: z.uuid().nullable().optional(),
    inventoryAdjustmentAccountId: z.uuid().nullable().optional(),
    stockOpeningAccountId: z.uuid().nullable().optional(),
    // Phase 43a — default payment terms.
    defaultSalesPaymentTermId: z.uuid().nullable().optional(),
    defaultPurchasePaymentTermId: z.uuid().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'No fields to update',
  });
