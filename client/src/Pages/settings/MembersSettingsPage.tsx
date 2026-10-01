import { Users } from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader';
import MembersPanel from '../MembersPanel';

/**
 * Organization settings → Members (Phase 38a): who belongs to this
 * organization, their roles, and invitations. Moved here from the Account
 * page's Members tab.
 */
export default function MembersSettingsPage() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        as="h2"
        icon={Users}
        title="Members"
        subtitle="Everyone with access to this organization, and the people you have invited."
      />
      <MembersPanel />
    </div>
  );
}
