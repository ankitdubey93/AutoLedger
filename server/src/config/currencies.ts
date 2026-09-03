/**
 * The currencies LedgerCore accepts as an organization's base currency.
 *
 * Platform layer, unprefixed — currency lives on `organizations.base_currency`,
 * not on any LedgerCore table. `as const` keeps each entry a string literal so
 * `CurrencyCode` is a real union rather than `string`, and this same array
 * feeds both the zod enum (`schemas/ledger-core/settingsSchema.ts`) and the
 * client's currency select — one source of truth, same pattern as
 * `ACCOUNT_TYPES` in `types/ledger-core.ts` and `ROLES` in `types/auth.ts`.
 */
export const SUPPORTED_CURRENCIES = [
  'USD',
  'EUR',
  'GBP',
  'INR',
  'CAD',
  'AUD',
  'JPY',
  'SGD',
  'AED',
  'CHF',
  'NZD',
  'ZAR',
] as const;

export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

/** Narrows a string to a known currency code. */
export function isSupportedCurrency(value: string): value is CurrencyCode {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}
