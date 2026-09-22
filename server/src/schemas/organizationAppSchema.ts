import { z } from 'zod';

/**
 * Request schema for PUT /organizations/apps — the full set of apps the
 * organization uses. Shape only; which slugs exist, and which apps require
 * which, is checked by organizationAppService.validateAppSelection against
 * config/apps.ts (the single source of truth for slugs).
 */
export const replaceOrganizationAppsSchema = z.object({
  appSlugs: z.array(z.string().trim().min(1).max(40)).min(1, 'Choose at least one app').max(20),
});
