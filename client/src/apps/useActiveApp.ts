import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getOrganizationApps, type AppSummary } from '../services/fetchServices';

export type ActiveAppState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'found'; app: AppSummary };

/**
 * Resolves the `:appSlug` route param against the registry, as seen by the
 * active organization: an app it has not enabled (Phase 27) reads as
 * `not-found`, so AppFrame redirects home rather than opening it.
 *
 * A hook rather than a context: the slug already lives in the URL, so there
 * is nothing to provide — every consumer that needs it is already inside a
 * route with that param.
 */
export function useActiveApp(): ActiveAppState {
  const { appSlug } = useParams<{ appSlug: string }>();
  const [state, setState] = useState<ActiveAppState>({ status: 'loading' });

  useEffect(() => {
    let ignore = false;
    setState({ status: 'loading' });

    getOrganizationApps()
      .then((res) => {
        if (ignore) return;
        const app = res.apps.find((a) => a.slug === appSlug);
        setState(app === undefined || !app.enabled ? { status: 'not-found' } : { status: 'found', app });
      })
      .catch(() => {
        if (!ignore) setState({ status: 'not-found' });
      });

    return () => {
      ignore = true;
    };
  }, [appSlug]);

  return state;
}
