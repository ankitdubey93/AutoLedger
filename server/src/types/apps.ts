/**
 * The app registry's types. See docs/architecture.md#suite-structure.
 *
 * AutoLedger is the suite; each entry here is one portfolio application
 * mounted inside it at /api/v1/<slug>. `status` distinguishes an app whose
 * routes actually exist ('building') from one that is only a roadmap entry
 * ('planned') — the client uses it to decide whether a card is a link or a
 * "Coming soon" placeholder.
 */

export type AppStatus = 'building' | 'planned';

export interface AppDefinition {
  slug: string;
  name: string;
  domain: string;
  tagline: string;
  skills: readonly string[];
  status: AppStatus;
  /**
   * Slugs of apps this one reads from or posts to. Choosing this app requires
   * choosing those. Every entry must be a slug in APPS (asserted by
   * apps.test.ts).
   */
  requires: readonly string[];
}

/** The wire shape of GET /apps. Identical to AppDefinition today, kept as a
 * separate type because the registry may grow fields the client has no need
 * to see (e.g. an internal phase number). */
export type AppSummary = AppDefinition;

/** One app as seen by one organization — GET/PUT /organizations/apps. */
export interface OrganizationAppEntry extends AppSummary {
  enabled: boolean;
  /** When this org enabled it; null when not enabled. */
  enabledAt: string | null;
}

export interface OrganizationApps {
  /** When the org last saved its selection (the 'platform' onboarding row's completed_at); null = never chosen. */
  selectionCompletedAt: string | null;
  /** In APPS registry order. */
  apps: OrganizationAppEntry[];
}
