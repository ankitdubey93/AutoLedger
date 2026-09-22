import { pool } from '../db/connect.js';
import { withTransaction } from '../db/transaction.js';
import { ApiError } from '../utils/apiError.js';
import { APPS, getApp, isAppSlug, type AppSlug } from '../config/apps.js';
import * as onboardingService from './onboardingService.js';
import type { AppDefinition, OrganizationApps } from '../types/apps.js';

/**
 * Which apps an organization has chosen to use — Phase 27.
 *
 * Every function takes `orgId` first and every statement carries an `org_id`
 * predicate (guardrails rule 1). `orgId` always originates from the verified
 * access token, never from a param, header or body.
 *
 * This decides visibility only: the client's chooser shows enabled apps and
 * redirects away from a disabled one. An app's own routes do not consult it.
 *
 * Saving a selection is a replace of the whole set, not an add/remove per
 * app: one validation pass sees every app at once (so a dependency can be
 * checked against the final set), and a repeated PUT is harmless.
 */

interface OrganizationAppRow {
  app_slug: string;
  enabled_at: Date;
}

/** Display name for an app slug, falling back to the slug itself. */
function nameOf(slug: string): string {
  return (APPS as readonly AppDefinition[]).find((a) => a.slug === slug)?.name ?? slug;
}

/**
 * Pure. Dedupes (keeping first-seen order) and checks each slug: it must be a
 * known app, not a `planned` one, and every app it `requires` must be in the
 * same selection. Throws ApiError(422).
 */
export function validateAppSelection(appSlugs: readonly string[]): AppSlug[] {
  const chosen: AppSlug[] = [];

  for (const slug of appSlugs) {
    if (!isAppSlug(slug)) throw new ApiError(422, `Unknown app "${slug}"`);
    if (chosen.includes(slug)) continue;
    const app = getApp(slug);
    if (app.status === 'planned') throw new ApiError(422, `${app.name} is not available yet`);
    chosen.push(slug);
  }

  const chosenSet = new Set<string>(chosen);
  for (const slug of chosen) {
    const app = getApp(slug);
    for (const req of app.requires) {
      if (!chosenSet.has(req)) throw new ApiError(422, `${app.name} requires ${nameOf(req)}`);
    }
  }

  return chosen;
}

/** Every app in registry order, flagged enabled or not for this organization. */
export async function getOrganizationApps(orgId: string): Promise<OrganizationApps> {
  const { rows } = await pool.query<OrganizationAppRow>(
    'SELECT app_slug, enabled_at FROM organization_apps WHERE org_id = $1',
    [orgId],
  );
  const bySlug = new Map(rows.map((row) => [row.app_slug, row]));

  // The 'platform' onboarding row is the "has this org ever chosen" marker —
  // the suite-level step this picker is. A missing row reads as NOT_STARTED.
  const platform = await onboardingService.getState(orgId, 'platform');
  const selectionCompletedAt = platform.status === 'COMPLETED' ? platform.completedAt : null;

  // Rows whose slug is not in APPS (an app since removed) are ignored.
  const apps = (APPS as readonly AppDefinition[]).map((app) => {
    const row = bySlug.get(app.slug);
    return {
      ...app,
      enabled: row !== undefined,
      enabledAt: row === undefined ? null : row.enabled_at.toISOString(),
    };
  });

  return { selectionCompletedAt, apps };
}

/**
 * Replaces the organization's enabled-app set with `appSlugs` and marks the
 * platform onboarding step COMPLETED — all in one transaction (rule 5).
 *
 * Apps that stay enabled keep their original `enabled_at`/`enabled_by`
 * (`ON CONFLICT DO NOTHING`). Removing an app deletes only its row here; the
 * app's own data is untouched and reappears if it is enabled again.
 */
export async function setOrganizationApps(
  orgId: string,
  userId: string,
  appSlugs: readonly string[],
): Promise<OrganizationApps> {
  // Validated before the transaction opens — a 422 costs no connection.
  const slugs = validateAppSelection(appSlugs);

  await withTransaction(async (client) => {
    // Locks the organization row so two concurrent replaces for the same org
    // run one after the other. Without it, both could DELETE against the old
    // set and both INSERT, leaving the union of the two selections.
    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM organizations WHERE id = $1 FOR UPDATE',
      [orgId],
    );
    if (rows[0] === undefined) throw new ApiError(404, 'Organization not found');

    // The slug list is bound as one text[] parameter, never joined into SQL (rule 4).
    await client.query(
      'DELETE FROM organization_apps WHERE org_id = $1 AND NOT (app_slug = ANY($2::text[]))',
      [orgId, slugs],
    );
    await client.query(
      `INSERT INTO organization_apps (org_id, app_slug, enabled_by)
       SELECT $1, s, $3 FROM unnest($2::text[]) AS s
       ON CONFLICT (org_id, app_slug) DO NOTHING`,
      [orgId, slugs, userId],
    );

    await onboardingService.markCompletedOnClient(client, orgId, 'platform');
  });

  return getOrganizationApps(orgId);
}
