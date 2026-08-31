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
}

/** The wire shape of GET /apps. Identical to AppDefinition today, kept as a
 * separate type because the registry may grow fields the client has no need
 * to see (e.g. an internal phase number). */
export type AppSummary = AppDefinition;
