import type { AppDefinition } from '../types/apps.js';

/**
 * The single source of truth for which apps exist and what their slugs are.
 *
 * `as const satisfies readonly AppDefinition[]` rather than a plain type
 * annotation: `satisfies` checks every entry against `AppDefinition` while
 * `as const` keeps each `slug` as its own string literal, so `AppSlug` below
 * is a real union (`'ledger-core' | 'taxguard' | ...`) instead of widening to
 * `string`. A route param can then be narrowed against it with `isAppSlug`.
 *
 * Adding an eighth app is a one-line addition here — nothing else in the
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
  },
  {
    slug: 'taxguard',
    name: 'TaxGuard AI',
    domain: 'Compliance & AI Workflows',
    tagline: 'RAG over tax law with PII-safe retrieval.',
    skills: ['RAG', 'Vector databases', 'PII redaction', 'Tax act parsing'],
    status: 'building',
  },
  {
    slug: 'ap-flow',
    name: 'AP-Flow',
    domain: 'Operational Accounting',
    tagline: 'Invoice capture to a posted journal entry, with a human in the loop.',
    skills: [
      'Multimodal OCR invoice parsing',
      'PII pixel masking',
      'History-driven COA mapping',
      'Human-in-the-loop review',
    ],
    status: 'building',
  },
  {
    slug: 'fpa-engine',
    name: 'FP&A Engine',
    domain: 'Financial Modeling',
    tagline: 'A linked 3-statement model you can stress-test.',
    skills: ['3-statement financial linking', 'Scenario modeling', 'Cash runway forecasting'],
    status: 'building',
  },
  {
    slug: 'unitecon',
    name: 'UnitEcon',
    domain: 'Commercial Analytics',
    tagline: 'Cohort retention and unit economics at a glance.',
    skills: ['Cohort retention matrices', 'LTV/CAC ratios', 'Price-Volume-Mix variance'],
    status: 'building',
  },
  {
    slug: 'boarddeck',
    name: 'BoardDeck Automator',
    domain: 'Board Reporting & Close',
    tagline: 'Close the books, generate the board deck.',
    skills: ['Monthly close automation', 'BvA variance', 'Automated .pptx deck generation'],
    status: 'building',
  },
  {
    slug: 'forecaster',
    name: 'ForecasterPro',
    domain: 'Budgeting & Planning',
    tagline: 'Driver-based rolling forecasts and headcount plans.',
    skills: ['Driver-based rolling forecasting', 'Headcount planning', 'Zero-based budgeting'],
    status: 'building',
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
