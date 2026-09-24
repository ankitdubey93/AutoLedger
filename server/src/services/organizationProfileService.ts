import type { PoolClient } from 'pg';
import { pool } from '../db/connect.js';
import { withTransaction } from '../db/transaction.js';
import { ApiError } from '../utils/apiError.js';
import type { OrganizationProfile, UpdateOrganizationProfileInput } from '../types/organization.js';

/**
 * The organization's postal identity — address, contact details, industry,
 * legal name and logo. Platform-level (migration 069), one row per org.
 *
 * The absence of an `organization_profiles` row means "never filled in", not
 * 404: `getProfile` returns `PROFILE_DEFAULTS` with `configured: false`, the
 * same convention `getInvoiceSettings` uses. There is no seed row.
 *
 * This file owns `organization_profiles` and nothing else (guardrails rule
 * 16) — it never reads `organizations` or `ledger_settings`.
 */

/** Both `pool` and a checked-out `PoolClient` satisfy this — see organizationService.ts. */
type Queryable = Pick<PoolClient, 'query'>;

const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_CHECK_VIOLATION = '23514';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

function pgConstraint(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('constraint' in err)) return undefined;
  return typeof err.constraint === 'string' ? err.constraint : undefined;
}

function pgErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return typeof err.message === 'string' ? err.message : 'Database rejected the organization profile';
  }
  return 'Database rejected the organization profile';
}

/** Mirrors migration 069's column DEFAULTs — the one place both sides read from. */
const PROFILE_DEFAULTS: Omit<OrganizationProfile, 'configured'> = {
  legalName: null,
  industry: null,
  streetAddress1: null,
  streetAddress2: null,
  city: null,
  region: null,
  postalCode: null,
  countryCode: null,
  postalSameAsStreet: true,
  postalAddress1: null,
  postalAddress2: null,
  postalCity: null,
  postalRegion: null,
  postalPostalCode: null,
  postalCountryCode: null,
  phone: null,
  contactEmail: null,
  website: null,
  logoDocumentId: null,
};

interface ProfileRow {
  legal_name: string | null;
  industry: string | null;
  street_address_1: string | null;
  street_address_2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string | null;
  postal_same_as_street: boolean;
  postal_address_1: string | null;
  postal_address_2: string | null;
  postal_city: string | null;
  postal_region: string | null;
  postal_postal_code: string | null;
  postal_country_code: string | null;
  phone: string | null;
  contact_email: string | null;
  website: string | null;
  logo_document_id: string | null;
}

function toOrganizationProfile(row: ProfileRow): OrganizationProfile {
  return {
    legalName: row.legal_name,
    industry: row.industry,
    streetAddress1: row.street_address_1,
    streetAddress2: row.street_address_2,
    city: row.city,
    region: row.region,
    postalCode: row.postal_code,
    // CHAR(2) is blank-padded on read in some drivers; trim defensively.
    countryCode: row.country_code === null ? null : row.country_code.trim(),
    postalSameAsStreet: row.postal_same_as_street,
    postalAddress1: row.postal_address_1,
    postalAddress2: row.postal_address_2,
    postalCity: row.postal_city,
    postalRegion: row.postal_region,
    postalPostalCode: row.postal_postal_code,
    postalCountryCode: row.postal_country_code === null ? null : row.postal_country_code.trim(),
    phone: row.phone,
    contactEmail: row.contact_email,
    website: row.website,
    logoDocumentId: row.logo_document_id,
    configured: true,
  };
}

/** Reads on whichever executor the caller owns, so an in-transaction read sees its own writes. */
async function readProfile(q: Queryable, orgId: string): Promise<OrganizationProfile> {
  const { rows } = await q.query<ProfileRow>(
    `SELECT legal_name, industry, street_address_1, street_address_2, city, region,
            postal_code, country_code, postal_same_as_street, postal_address_1,
            postal_address_2, postal_city, postal_region, postal_postal_code,
            postal_country_code, phone, contact_email, website, logo_document_id
       FROM organization_profiles
      WHERE org_id = $1`,
    [orgId],
  );

  const row = rows[0];
  if (row === undefined) return { ...PROFILE_DEFAULTS, configured: false };
  return toOrganizationProfile(row);
}

/** GET /organizations/profile. No row is not a 404 — it means "never filled in". */
export async function getProfile(orgId: string): Promise<OrganizationProfile> {
  return readProfile(pool, orgId);
}

/**
 * The upsert both `updateProfile` and `upsertProfileOnClient` share. Runs on
 * whatever executor it is handed and never opens a transaction itself.
 */
async function runUpsert(
  q: Queryable,
  orgId: string,
  input: UpdateOrganizationProfileInput,
): Promise<void> {
  // Column names come from this frozen map, never from the request — rule 4
  // forbids interpolating an identifier a caller could influence.
  const COLUMNS = {
    legalName: 'legal_name',
    industry: 'industry',
    streetAddress1: 'street_address_1',
    streetAddress2: 'street_address_2',
    city: 'city',
    region: 'region',
    postalCode: 'postal_code',
    countryCode: 'country_code',
    postalSameAsStreet: 'postal_same_as_street',
    postalAddress1: 'postal_address_1',
    postalAddress2: 'postal_address_2',
    postalCity: 'postal_city',
    postalRegion: 'postal_region',
    postalPostalCode: 'postal_postal_code',
    postalCountryCode: 'postal_country_code',
    phone: 'phone',
    contactEmail: 'contact_email',
    website: 'website',
    logoDocumentId: 'logo_document_id',
  } as const;

  const columns: string[] = [];
  const insertValues: unknown[] = [];
  const updateAssignments: string[] = [];

  for (const key of Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]) {
    let value = input[key];
    if (value === undefined) continue;

    // Rule 9: emails are lowercased on write. Country codes are stored upper-case
    // (migration 069's CHECK is `^[A-Z]{2}$`).
    if (typeof value === 'string') {
      if (key === 'contactEmail') value = value.toLowerCase();
      else if (key === 'countryCode' || key === 'postalCountryCode') value = value.toUpperCase();
    }

    columns.push(COLUMNS[key]);
    insertValues.push(value);
    updateAssignments.push(`${COLUMNS[key]} = EXCLUDED.${COLUMNS[key]}`);
  }

  if (columns.length === 0) throw new ApiError(400, 'No fields to update');

  const placeholders = insertValues.map((_, i) => `$${String(i + 2)}`);

  try {
    await q.query(
      `INSERT INTO organization_profiles (org_id, ${columns.join(', ')})
       VALUES ($1, ${placeholders.join(', ')})
       ON CONFLICT (org_id) DO UPDATE SET ${updateAssignments.join(', ')}`,
      [orgId, ...insertValues],
    );
  } catch (err) {
    if (
      pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION &&
      pgConstraint(err) === 'fk_organization_profiles_logo_document'
    ) {
      throw new ApiError(422, 'Logo document does not exist in this organization');
    }
    if (pgErrorCode(err) === PG_CHECK_VIOLATION) {
      throw new ApiError(422, pgErrorMessage(err));
    }
    throw err;
  }
}

/**
 * PATCH /organizations/profile. Creates the row on first write.
 *
 * Takes a `Queryable` last, defaulting to `pool`, mirroring
 * `organizationService.updateOrganization`: when the caller passes no
 * executor this opens its own transaction (every write needs one so the audit
 * context attaches); when the caller passes its own checked-out `client`, the
 * write runs on it and commits or rolls back with the caller's transaction
 * (rule 5) — wrapping it again would `BEGIN` inside an open transaction.
 */
export async function updateProfile(
  orgId: string,
  input: UpdateOrganizationProfileInput,
  q: Queryable = pool,
): Promise<OrganizationProfile> {
  async function run(executor: Queryable): Promise<OrganizationProfile> {
    await runUpsert(executor, orgId, input);
    return readProfile(executor, orgId);
  }

  return q === pool ? withTransaction(run) : run(q);
}

/**
 * The same upsert on the caller's checked-out `client`, returning nothing, so
 * `settingsService` can fold the profile write into its own transaction
 * (rule 5) — never `pool`.
 */
export async function upsertProfileOnClient(
  client: PoolClient,
  orgId: string,
  input: UpdateOrganizationProfileInput,
): Promise<void> {
  await runUpsert(client, orgId, input);
}
