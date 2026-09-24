import { useAppBasePath } from '../../apps/useAppBasePath';
import AppSidebar, { type SidebarNavGroup } from '../../components/layout/AppSidebar';
import { AP_FLOW_NAV_GROUPS } from './apFlowNav';

/**
 * AP-Flow's sidebar — new in Phase 31. AP-Flow had no sidebar before this;
 * its four routes were reached only from header links on the documents
 * page. See LedgerCoreSidebar's doc comment for why the hrefs must be
 * absolute.
 */
export default function ApFlowSidebar() {
  const base = useAppBasePath();
  const groups: SidebarNavGroup[] = AP_FLOW_NAV_GROUPS.map((group) => ({
    heading: group.heading,
    items: group.items.map((item) => ({ ...item, to: item.to === '' ? base : `${base}/${item.to}` })),
  }));

  return <AppSidebar ariaLabel="AP-Flow" storageKey="ap-flow" groups={groups} />;
}
