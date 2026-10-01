/**
 * Organization and tenancy types. See docs/architecture.md for the model.
 *
 * Convention throughout: a nullable database column is typed `T | null`, never
 * `field?: T`. Under `exactOptionalPropertyTypes` an optional property and a
 * property explicitly set to `undefined` are different types, so `?:` forces
 * conditional-spread gymnastics at every construction site. `| null` also
 * matches what the `pg` driver actually hands back.
 */

import type { Role } from './auth.js';

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

/* ------------------------------------------------- Phase 37 — invitations */

/**
 * An invitation's lifecycle. Derived from the row's timestamps, never stored
 * (migration 079): `accepted_at` set → ACCEPTED, `revoked_at` set → REVOKED,
 * past `expires_at` → EXPIRED, otherwise PENDING.
 */
export const INVITATION_STATUSES = ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/**
 * The one transition table for invitations (guardrails rule 10). Every
 * terminal state is terminal: a revoked or expired invitation is never
 * reopened — the inviter sends a new one, with a new token.
 *
 * EXPIRED is reached by the clock, not by a write, so nothing ever asks to
 * move *to* it; it is listed so the table is a complete picture. An expired
 * invitation may still be closed out (EXPIRED -> REVOKED): that is what frees
 * the address for a new invitation under the partial unique index.
 */
export const INVITATION_TRANSITIONS: Readonly<Record<InvitationStatus, readonly InvitationStatus[]>> = {
  PENDING: ['ACCEPTED', 'REVOKED', 'EXPIRED'],
  ACCEPTED: [],
  REVOKED: [],
  EXPIRED: ['REVOKED'],
};

export function canTransitionInvitation(from: InvitationStatus, to: InvitationStatus): boolean {
  return INVITATION_TRANSITIONS[from].includes(to);
}

/** What an OWNER/ADMIN sees in the pending-invitations list. */
export interface Invitation {
  id: string;
  email: string;
  role: Role;
  /** Phase 38c — set when `role` is 'CUSTOM'. */
  customRoleId: string | null;
  roleName: string;
  status: InvitationStatus;
  invitedByName: string | null;
  expiresAt: string;
  createdAt: string;
}

/** The public preview behind an invite link — only what the accept page needs. */
export interface InvitationPreview {
  organizationName: string;
  invitedByName: string | null;
  email: string;
  role: Role;
  roleName: string;
  status: InvitationStatus;
  expiresAt: string;
}
