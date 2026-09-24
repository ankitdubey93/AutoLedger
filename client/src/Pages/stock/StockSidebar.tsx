import { useAppBasePath } from '../../apps/useAppBasePath';
import AppSidebar, { type SidebarNavGroup } from '../../components/layout/AppSidebar';
import { STOCK_NAV_GROUPS } from './stockNav';

/** StockLedger's sidebar — a thin wrapper over AppSidebar (Phase 31). See LedgerCoreSidebar's doc comment for why the hrefs must be absolute. */
export default function StockSidebar() {
  const base = useAppBasePath();
  const groups: SidebarNavGroup[] = STOCK_NAV_GROUPS.map((group) => ({
    heading: group.heading,
    items: group.items.map((item) => ({ ...item, to: `${base}/${item.to}` })),
  }));

  return <AppSidebar ariaLabel="StockLedger" storageKey="stock" groups={groups} />;
}
