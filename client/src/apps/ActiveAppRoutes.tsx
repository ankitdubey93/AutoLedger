import { Navigate, useParams } from 'react-router-dom';
import { APP_ELEMENTS } from './registry';

/**
 * Renders whichever app owns the current `:appSlug`.
 *
 * Resolving the slug at render time rather than generating one `<Route>` per
 * entry matters once there is more than one app: a static list of sibling
 * `index` routes would have several routes matching the same path, and the
 * first would win regardless of which app the URL actually named.
 *
 * AppShell has already rejected unknown and `planned` slugs by the time this
 * renders; the guard here covers the case of an app the API reports as
 * `building` that has no client routes registered yet.
 */
export default function ActiveAppRoutes() {
  const { appSlug } = useParams<{ appSlug: string }>();
  const AppRoutes = appSlug === undefined ? undefined : APP_ELEMENTS[appSlug];

  if (AppRoutes === undefined) return <Navigate to="/" replace />;
  return <AppRoutes />;
}
