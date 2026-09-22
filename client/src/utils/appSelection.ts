import type { AppSummary } from '../services/fetchServices';

/**
 * Pure selection rules for the app picker (Phase 27), mirroring the server's
 * organizationAppService.validateAppSelection so the UI never offers a set the
 * server would reject with "X requires Y".
 */

/**
 * Ticking adds the slug and everything it `requires`. Unticking removes only
 * the slug, and does nothing when a selected app requires it.
 */
export function toggleApp(
  apps: readonly AppSummary[],
  selected: ReadonlySet<string>,
  slug: string,
): Set<string> {
  const next = new Set(selected);

  if (selected.has(slug)) {
    if (requiredBy(apps, selected, slug).length > 0) return next;
    next.delete(slug);
    return next;
  }

  next.add(slug);
  const app = apps.find((a) => a.slug === slug);
  for (const req of app?.requires ?? []) next.add(req);
  return next;
}

/** Names of currently selected apps whose `requires` includes `slug`. */
export function requiredBy(
  apps: readonly AppSummary[],
  selected: ReadonlySet<string>,
  slug: string,
): string[] {
  return apps
    .filter((a) => a.slug !== slug && selected.has(a.slug) && a.requires.includes(slug))
    .map((a) => a.name);
}
