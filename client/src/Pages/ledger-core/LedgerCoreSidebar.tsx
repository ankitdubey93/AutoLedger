import { useAppBasePath } from '../../apps/useAppBasePath';
import AppSidebar, { type SidebarNavGroup } from '../../components/layout/AppSidebar';
import CreateMenu from './CreateMenu';
import { LEDGER_CORE_NAV_GROUPS } from './ledgerCoreNav';

/**
 * LedgerCore's sidebar — a thin wrapper over the shared AppSidebar (Phase
 * 31), resolving `ledgerCoreNav.ts`'s app-relative suffixes against
 * `useAppBasePath()` into absolute hrefs. `''` means the app root.
 *
 * Absolute targets matter here specifically: this sidebar renders inside a
 * descendant `<Routes>` under the platform's `/app/:appSlug` splat, and
 * react-router resolves a relative `to` against that splat match's full
 * pathname, so `'journals'` clicked from `/app/ledger-core/accounts` would
 * resolve to `/app/ledger-core/accounts/journals` if it were relative.
 */
export default function LedgerCoreSidebar() {
  const base = useAppBasePath();
  const groups: SidebarNavGroup[] = LEDGER_CORE_NAV_GROUPS.map((group) => ({
    heading: group.heading,
    items: group.items.map((item) => ({ ...item, to: item.to === '' ? base : `${base}/${item.to}` })),
  }));

  return <AppSidebar ariaLabel="LedgerCore" storageKey="ledger-core" groups={groups} header={<CreateMenu />} />;
}
