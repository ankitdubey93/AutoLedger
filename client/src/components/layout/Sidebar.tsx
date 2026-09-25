import AppSidebar from './AppSidebar';
import CreateMenu from './CreateMenu';
import { NAV_GROUPS } from './nav';

/** The product's sidebar: the shared rail over `NAV_GROUPS`, with the "New" menu on top. */
export default function Sidebar() {
  return <AppSidebar ariaLabel="AutoLedger" storageKey="workspace" groups={NAV_GROUPS} header={<CreateMenu />} />;
}
