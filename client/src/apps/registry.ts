/**
 * Maps an app slug to the element its routes render. This is route wiring
 * only — display data (name, domain, tagline, status) comes from
 * GET /api/v1/apps (services/fetchServices.ts) so the server stays the single
 * source of truth and nothing here can drift out of sync with it.
 *
 * A slug with `status: 'planned'` (from the API) has no entry here — AppShell
 * redirects those back to the chooser instead of rendering an outlet with
 * nothing to show.
 *
 * Each element owns its app's internal routing. The platform router knows only
 * that `/app/<slug>/*` belongs to that app, which is the routing counterpart of
 * the app boundary the server enforces (guardrails rule 16).
 */
import type { ComponentType } from 'react';
import LedgerCoreRoutes from '../Pages/ledger-core/LedgerCoreRoutes';

export const APP_ELEMENTS: Record<string, ComponentType> = {
  'ledger-core': LedgerCoreRoutes,
};
