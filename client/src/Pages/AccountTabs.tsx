import { Bell, Building2, KeyRound, MonitorSmartphone, Server, UserRound } from 'lucide-react';
import TabBar from '../components/ui/TabBar';

/** Phase 38a — user-level tabs only; organization settings live under /settings. */
export const ACCOUNT_TABS = ['profile', 'password', 'sessions', 'notifications', 'organizations', 'system'] as const;
export type AccountTab = (typeof ACCOUNT_TABS)[number];

export interface AccountTabsProps {
  active: AccountTab;
  onChange: (tab: AccountTab) => void;
}

/** The tab strip for Account settings — a thin wrapper over the shared TabBar (Phase 31). */
export default function AccountTabs({ active, onChange }: AccountTabsProps) {
  return (
    <TabBar
      ariaLabel="Account settings"
      variant="buttons"
      fullWidth
      active={active}
      onChange={(id) => onChange(id as AccountTab)}
      items={[
        { id: 'profile', label: 'Profile', icon: UserRound },
        { id: 'password', label: 'Password', icon: KeyRound },
        { id: 'sessions', label: 'Sessions', icon: MonitorSmartphone },
        { id: 'notifications', label: 'Notifications', icon: Bell },
        { id: 'organizations', label: 'Organizations', icon: Building2 },
        { id: 'system', label: 'Status', icon: Server },
      ]}
    />
  );
}
