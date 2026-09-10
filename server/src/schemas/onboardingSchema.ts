import { z } from 'zod';

/**
 * Request schema for PUT /onboarding/:appSlug/draft. Platform layer,
 * unprefixed, mirroring `schemas/organizationSchema.ts`.
 *
 * `draft` is untrusted JSON — it is stored opaquely and re-parsed through the
 * target app's own zod schema at completion time, never spread into a query
 * or used to pick a column here.
 */
export const saveDraftSchema = z.object({
  currentStep: z.string().trim().min(1).max(60).nullable().default(null),
  draft: z.record(z.string(), z.unknown()).default({}),
});
