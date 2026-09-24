import { Inbox, ListChecks, Gauge, SlidersHorizontal } from 'lucide-react';

/**
 * AP-Flow's navigation as data. AP-Flow had no sidebar before Phase 31 —
 * these four routes were reached only from header links on the documents
 * page. New in this phase, not extracted from anywhere.
 */
export const AP_FLOW_NAV_GROUPS = [
  {
    heading: 'AP automation',
    items: [
      { to: '', label: 'Documents', icon: Inbox, end: true },
      { to: 'review', label: 'Review queue', icon: ListChecks, end: false },
      { to: 'usage', label: 'AI usage', icon: Gauge, end: false },
      { to: 'settings', label: 'Settings', icon: SlidersHorizontal, end: false },
    ],
  },
] as const;
