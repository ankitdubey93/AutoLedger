import { Building2 } from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader';
import OrganizationProfilePanel from '../OrganizationProfilePanel';
import BusinessIdentificationPanel from './BusinessIdentificationPanel';

/**
 * Organization settings → Profile (Phase 38a): the company's address,
 * contact details, logo and registration numbers. Moved here from the
 * Account page, which is now about the person, not the company.
 */
export default function OrganizationProfileSettingsPage() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        as="h2"
        icon={Building2}
        title="Organization profile"
        subtitle="Address, contact details, logo and registration numbers — shown on your invoices."
      />
      <div className="grid">
        <OrganizationProfilePanel />
        <BusinessIdentificationPanel />
      </div>
    </div>
  );
}
