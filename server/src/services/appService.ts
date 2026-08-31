import { APPS } from '../config/apps.js';
import type { AppSummary } from '../types/apps.js';

/**
 * No SQL here yet — the registry is a static list (docs/architecture.md). It
 * still goes through a service, not the controller, because entitlement
 * ("which apps can this org see") is exactly the kind of thing that becomes a
 * DB query later, and callers should not need to change when it does.
 */
export function listApps(): AppSummary[] {
  return [...APPS];
}
