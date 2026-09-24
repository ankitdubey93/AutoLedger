import { useEffect, useState } from 'react';
import { getOrganizationApps, type AppSummary, type OrganizationAppEntry } from '../services/fetchServices';
import { useOrg } from '../context/OrgContext';

export type EnabledAppsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; apps: OrganizationAppEntry[] };

/**
 * `GET /organizations/apps`, fetched once per organization rather than once
 * per `:appSlug`. The app switcher menu in AppTopBar and the command palette
 * both need "every app this org has enabled", and AppFrame needs the one
 * that matches the current URL — one fetch serves all three.
 *
 * This replaces the old per-slug `useActiveApp`, whose effect depended on
 * `appSlug` and reset to `loading` on every crossing between apps, flashing
 * a skeleton each time. Keying on `[organization?.id, orgVersion]` instead
 * means moving from one app to another re-renders with data already in
 * hand — see study/react/routing-nested-and-dynamic-segments.md.
 */
export function useEnabledApps(): EnabledAppsState {
  const { organization, orgVersion } = useOrg();
  const [state, setState] = useState<EnabledAppsState>({ status: 'loading' });

  useEffect(() => {
    let ignore = false;
    setState({ status: 'loading' });

    getOrganizationApps()
      .then((res) => {
        if (ignore) return;
        setState({ status: 'ready', apps: res.apps.filter((a) => a.enabled && a.status === 'building') });
      })
      .catch((err: unknown) => {
        if (!ignore) setState({ status: 'error', message: err instanceof Error ? err.message : 'Could not load apps' });
      });

    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organization?.id, orgVersion]);

  return state;
}

export type ActiveAppState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'found'; app: AppSummary };

/** Pure: resolves `:appSlug` against an already-fetched enabled-apps state. */
export function resolveActiveApp(state: EnabledAppsState, appSlug: string | undefined): ActiveAppState {
  if (state.status === 'loading') return { status: 'loading' };
  if (state.status === 'error') return { status: 'not-found' };
  const app = state.apps.find((a) => a.slug === appSlug);
  return app === undefined ? { status: 'not-found' } : { status: 'found', app };
}
