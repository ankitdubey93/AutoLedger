import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from '../config/currencies.js';
import { ROLES } from '../types/auth.js';

/**
 * Request schema for editing the active organization. Platform layer,
 * unprefixed — mirrors `schemas/accounting/settingsSchema.ts`'s shape but
 * lives at the layer root because `organizations` is a platform table.
 */
export const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    baseCurrency: z.enum(SUPPORTED_CURRENCIES).optional(),
    taxNumber: z.string().trim().max(64).nullable().optional(),
    businessNumber: z.string().trim().max(64).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'No fields to update',
  });

/** Phase 37 — POST /organizations: an existing user adds an organization. */
export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120),
});

/** Phase 37 — POST /organizations/invitations. Email lowercased here and again in the service (rule 9). */
export const createInvitationSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: z.enum(ROLES),
});

/** Phase 37 — PATCH /organizations/members/:userId. */
export const updateMemberRoleSchema = z.object({
  role: z.enum(ROLES),
});
