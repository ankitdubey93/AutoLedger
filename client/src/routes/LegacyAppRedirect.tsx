import { Navigate, useLocation, useParams } from 'react-router-dom';

/**
 * Pre-Phase-33 URLs had the form `/app/<slug>/<rest>`, one namespace per app.
 * They still arrive from bookmarks, emails and, above all, printed QR labels,
 * which encode `/app/stock/scan/<kind>/<id>` and cannot be reprinted
 * remotely. This route translates them for good.
 *
 * Pure so the mapping can be tested without a router.
 */
export function legacyTarget(slug: string, rest: string): string {
  const path = rest.replace(/^\/+|\/+$/g, '');
  const is = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

  if (slug === 'ledger-core') {
    if (is('items')) return `/products${path.slice('items'.length)}`;
    if (path === 'settings') return '/settings/general';
    if (is('audit')) return '/settings/audit';
    if (is('webhooks')) return `/settings/${path}`;
    return `/${path}`;
  }
  if (slug === 'ap-flow') {
    if (path === 'settings') return '/settings/inbox';
    if (path === 'usage') return '/settings/ai-usage';
    return path === '' ? '/inbox' : `/inbox/${path}`;
  }
  if (slug === 'stock') {
    if (path === '' || path === 'dashboard') return '/';
    if (path === 'settings') return '/settings/inventory';
    if (path === 'settings/codes') return '/settings/inventory/codes';
    return `/inventory/${path}`;
  }
  return '/';
}

export default function LegacyAppRedirect() {
  const { appSlug = '', '*': rest = '' } = useParams();
  const { search, hash } = useLocation();
  return <Navigate to={`${legacyTarget(appSlug, rest)}${search}${hash}`} replace />;
}
