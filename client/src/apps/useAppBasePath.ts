import { useParams } from 'react-router-dom';

/**
 * The absolute URL prefix of the app that owns the current route.
 *
 * Lives in `apps/` rather than in any one app because `/app/:appSlug` is the
 * platform's URL shape: LedgerCore should not know it, and the next app
 * should not restate it.
 *
 * Why absolute paths at all — react-router resolves a relative `to` against
 * the *full* pathname of the deepest path-contributing match
 * (`getResolveToMatches` uses `match.pathname`, not `match.pathnameBase`).
 * An app's pages render inside a descendant `<Routes>` mounted under the
 * `/app/:appSlug` splat, so that match's pathname is the whole current URL,
 * and a relative `to="journals"` appends to wherever you already are instead
 * of replacing the page. See study/react/routing-nested-and-dynamic-segments.md.
 */
export function useAppBasePath(): string {
  const { appSlug } = useParams<{ appSlug: string }>();
  return appSlug === undefined ? '/' : `/app/${appSlug}`;
}
