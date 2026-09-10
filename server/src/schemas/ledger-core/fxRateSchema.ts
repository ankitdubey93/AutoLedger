import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from '../../config/currencies.js';
import { FX_RATE_SOURCES } from '../../types/ledger-core.js';

/**
 * `rate` is a string on the wire, not a number — a JSON number cannot carry
 * 8 decimal places reliably and would arrive as a float. See
 * utils/fxRate.ts and study/postgresql/multi-currency-and-functional-currency.md.
 *
 * fromCode/toCode are restricted to SUPPORTED_CURRENCIES, the same whitelist
 * organizationSchema.baseCurrency and settingsSchema use — one list of
 * currencies the application actually understands, not a bare 3-letter regex.
 */
export const upsertFxRateSchema = z.object({
  fromCode: z.enum(SUPPORTED_CURRENCIES),
  toCode: z.enum(SUPPORTED_CURRENCIES),
  rateDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'rateDate must be YYYY-MM-DD'),
  rate: z
    .string()
    .regex(
      /^(?!0+(?:\.0+)?$)\d{1,10}(?:\.\d{1,8})?$/,
      'rate must be a positive decimal with at most 8 decimal places',
    ),
  source: z.enum(FX_RATE_SOURCES).default('MANUAL'),
});
