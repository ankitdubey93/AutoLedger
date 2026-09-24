/**
 * Organization and tenancy types. See docs/architecture.md for the model.
 *
 * Convention throughout: a nullable database column is typed `T | null`, never
 * `field?: T`. Under `exactOptionalPropertyTypes` an optional property and a
 * property explicitly set to `undefined` are different types, so `?:` forces
 * conditional-spread gymnastics at every construction site. `| null` also
 * matches what the `pg` driver actually hands back.
 */

/** A complete organization profile — the postal identity, logo and company metadata. */
export interface OrganizationProfile {
  legalName: string | null;
  industry: string | null;
  streetAddress1: string | null;
  streetAddress2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string | null;
  postalSameAsStreet: boolean;
  postalAddress1: string | null;
  postalAddress2: string | null;
  postalCity: string | null;
  postalRegion: string | null;
  postalPostalCode: string | null;
  postalCountryCode: string | null;
  phone: string | null;
  contactEmail: string | null;
  website: string | null;
  logoDocumentId: string | null;
  /** `false` until the organization has saved a profile at least once. */
  configured: boolean;
}

/**
 * Every field optional AND explicitly `| undefined`. `tsconfig.json` sets
 * `exactOptionalPropertyTypes`, under which plain `Partial<...>` rejects an explicit
 * `undefined` — and zod's `.optional()` infers `field?: T | undefined`, so
 * `parseBody(updateOrganizationProfileSchema, ...)` would not be assignable to it.
 * Same reason `UpdateInvoiceSettingsInput` spells `| undefined` on every field.
 */
type ProfileFields = Omit<OrganizationProfile, 'configured'>;
export type UpdateOrganizationProfileInput = { [K in keyof ProfileFields]?: ProfileFields[K] | undefined };
