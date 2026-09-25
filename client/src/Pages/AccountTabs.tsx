import { Building2, KeyRound, Server, Users } from 'lucide-react';
import TabBar from '../components/ui/TabBar';

export type AccountTab = 'organization' | 'members' | 'session' | 'system';

export interface AccountTabsProps {
  active: AccountTab;
  onChange: (tab: AccountTab) => void;
}

/** The tab strip for the Account page — a thin wrapper over the shared TabBar (Phase 31). */
export default function AccountTabs({ active, onChange }: AccountTabsProps) {
  return (
    <TabBar
      ariaLabel="Account"
      variant="buttons"
      fullWidth
      active={active}
      onChange={(id) => onChange(id as AccountTab)}
      items={[
        { id: 'organization', label: 'Organisation', icon: Building2 },
        { id: 'members', label: 'Members', icon: Users },
        { id: 'session', label: 'Session', icon: KeyRound },
        { id: 'system', label: 'System', icon: Server },
      ]}
    />
  );
}
