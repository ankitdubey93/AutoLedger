/**
 * Maps an app slug to the element its routes render. This is route wiring
 * only — display data (name, domain, tagline, status) comes from
 * GET /api/v1/apps (services/fetchServices.ts) so the server stays the single
 * source of truth and nothing here can drift out of sync with it.
 *
 * A slug with `status: 'planned'` (from the API) has no entry here — AppFrame
 * redirects those back to the chooser instead of rendering an outlet with
 * nothing to show.
 *
 * Each element owns its app's internal routing. The platform router knows only
 * that `/app/<slug>/*` belongs to that app, which is the routing counterpart of
 * the app boundary the server enforces (guardrails rule 16).
 */
import type { ComponentType } from 'react';
import { BookOpen, Boxes, Inbox, type LucideIcon } from 'lucide-react';
import LedgerCoreRoutes from '../Pages/ledger-core/LedgerCoreRoutes';
import ApFlowRoutes from '../Pages/ap-flow/ApFlowRoutes';
import StockRoutes from '../Pages/stock/StockRoutes';
import { LEDGER_CORE_NAV_GROUPS } from '../Pages/ledger-core/ledgerCoreNav';
import { AP_FLOW_NAV_GROUPS } from '../Pages/ap-flow/apFlowNav';
import { STOCK_NAV_GROUPS } from '../Pages/stock/stockNav';

export const APP_ELEMENTS: Record<string, ComponentType> = {
  'ledger-core': LedgerCoreRoutes,
  'ap-flow': ApFlowRoutes,
  stock: StockRoutes,
};

/**
 * One icon and one accent color per app — the app switcher menu and the
 * suite chooser cards use these to make "which app am I in" recognisable at
 * a glance, since the three apps otherwise share one palette.
 */
export const APP_BRAND: Record<string, { icon: LucideIcon; color: string }> = {
  'ledger-core': { icon: BookOpen, color: '#7c6cf6' },
  'ap-flow': { icon: Inbox, color: '#2dd4bf' },
  stock: { icon: Boxes, color: '#f5a524' },
};

/**
 * Each app's nav groups, keyed by slug and reusing the exact data the
 * sidebars render from — for the command palette (Phase 31), so "jump to
 * Invoices" or "jump to Item codes" works for apps other than the one
 * currently open without one app importing another's page (rule 16: this
 * is data, not a page import).
 */
export const APP_NAV: Record<string, typeof LEDGER_CORE_NAV_GROUPS | typeof AP_FLOW_NAV_GROUPS | typeof STOCK_NAV_GROUPS> = {
  'ledger-core': LEDGER_CORE_NAV_GROUPS,
  'ap-flow': AP_FLOW_NAV_GROUPS,
  stock: STOCK_NAV_GROUPS,
};
