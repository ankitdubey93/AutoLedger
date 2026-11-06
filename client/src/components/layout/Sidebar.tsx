import { useRegion } from '../../context/LedgerSettingsContext';
import AppSidebar from './AppSidebar';
import CreateMenu from './CreateMenu';
import { visibleNavGroups } from './nav';
import { useCan } from '../../context/AuthContext';

/** The product's sidebar: the shared rail over `NAV_GROUPS`, with the "New" menu on top. */
export default function Sidebar() {
  const can = useCan();
  const region = useRegion();
  return <AppSidebar ariaLabel="AutoLedger" groups={visibleNavGroups(can, region)} header={<CreateMenu />} />;
}
