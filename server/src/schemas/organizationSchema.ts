import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from '../config/currencies.js';
import { BUILTIN_ROLES } from '../types/auth.js';
import { NOTIFICATION_EVENTS } from '../types/email.js';

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
export const createInvitationSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    // Phase 38c — exactly one of a built-in role or a custom role id.
    role: z.enum(BUILTIN_ROLES).optional(),
    customRoleId: z.uuid().optional(),
  })
  .refine((v) => (v.role === undefined) !== (v.customRoleId === undefined), {
    message: 'Give either a role or a customRoleId',
  });

/** Phase 37 — PATCH /organizations/members/:userId. */
export const updateMemberRoleSchema = z
  .object({
    role: z.enum(BUILTIN_ROLES).optional(),
    customRoleId: z.uuid().optional(),
  })
  .refine((v) => (v.role === undefined) !== (v.customRoleId === undefined), {
    message: 'Give either a role or a customRoleId',
  });

/** Phase 38c — POST /organizations/roles and PATCH /organizations/roles/:id. */
export const roleBodySchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).nullable().optional(),
  permissions: z.array(z.string().max(60)).max(200),
});

/** Phase 38b — PATCH /organizations/email-settings. `null` resets to the default. */
export const updateEmailSettingsSchema = z
  .object({
    senderName: z.string().trim().min(1).max(100).nullable().optional(),
    replyTo: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

/** Phase 38b — PUT /auth/me/notifications. */
export const notificationPreferencesSchema = z.object({
  preferences: z
    .array(z.object({ event: z.enum(NOTIFICATION_EVENTS), enabled: z.boolean() }))
    .min(1)
    .max(NOTIFICATION_EVENTS.length),
});
