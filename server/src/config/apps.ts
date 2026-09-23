import type { AppDefinition } from '../types/apps.js';

/**
 * The single source of truth for which apps exist and what their slugs are.
 *
 * `as const satisfies readonly AppDefinition[]` rather than a plain type
 * annotation: `satisfies` checks every entry against `AppDefinition` while
 * `as const` keeps each `slug` as its own string literal, so `AppSlug` below
 * is a real union (`'ledger-core' | 'ap-flow' | 'stock'`) instead of widening to
 * `string`. A route param can then be narrowed against it with `isAppSlug`.
 *
 * Adding a fourth app is a one-line addition here — nothing else in the
 * platform layer needs to change.
 */
export const APPS = [
  {
    slug: 'ledger-core',
    name: 'LedgerCore',
    domain: 'Core Accounting & Systems',
    tagline: 'Double-entry ledger, multi-currency, QuickBooks sync.',
    skills: ['Double-entry integrity', 'DB constraints', 'Multi-currency', 'QuickBooks API sync'],
    status: 'building',
    requires: [],
  },
  {
    slug: 'ap-flow',
    name: 'AP-Flow',
    domain: 'Operational Accounting',
    tagline: 'Invoice capture to a posted LedgerCore bill — automatic when confident, reviewed when not.',
    skills: [
      'Multimodal OCR invoice parsing',
      'PII pixel masking',
      'History-driven COA mapping',
      'Human-in-the-loop review',
      'Confidence-gated auto-posting',
    ],
    status: 'building',
    requires: ['ledger-core'],
  },
  {
    slug: 'stock',
    name: 'StockLedger',
    domain: 'Inventory & Warehousing',
    tagline: 'Industry-ready inventory with your own item codes and QR labels.',
    skills: [
      'Industry inventory templates',
      'User-defined item attributes (JSONB)',
      'Configurable item-code schemes',
      'QR code labelling',
      'Perpetual inventory with moving-average and specific-identification costing',
      'Pessimistic locking on stock balances',
    ],
    status: 'building',
    requires: [],
  },
] as const satisfies readonly AppDefinition[];

export type AppSlug = (typeof APPS)[number]['slug'];

/** Narrows an unknown string (a route param) to a known app slug. */
export function isAppSlug(value: string): value is AppSlug {
  return (APPS as readonly AppDefinition[]).some((app) => app.slug === value);
}

export function getApp(slug: AppSlug): AppDefinition {
  const app = (APPS as readonly AppDefinition[]).find((a) => a.slug === slug);
  if (app === undefined) throw new Error(`Unknown app slug "${slug}"`);
  return app;
}
