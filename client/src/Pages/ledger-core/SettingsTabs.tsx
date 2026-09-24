import {
  Building2,
  FileStack,
  FileText,
  GitCompareArrows,
  Landmark,
  ListTree,
  Receipt,
} from 'lucide-react';
import { useAppBasePath } from '../../apps/useAppBasePath';
import TabBar from '../../components/ui/TabBar';

/** The tab strip shared by SettingsPage, InvoiceSettingsPage and PaymentTermsSettingsPage — a thin wrapper over the shared TabBar (Phase 31). */
export default function SettingsTabs() {
  const base = useAppBasePath();

  return (
    <TabBar
      ariaLabel="Settings"
      variant="links"
      items={[
        { id: 'organization', label: 'Organization', icon: Building2, to: `${base}/settings`, end: true },
        { id: 'financial', label: 'Financial', icon: Landmark, to: `${base}/settings/financial` },
        { id: 'chart', label: 'Chart of accounts', icon: ListTree, to: `${base}/settings/chart` },
        {
          id: 'conversion-balances',
          label: 'Conversion balances',
          icon: GitCompareArrows,
          to: `${base}/settings/conversion-balances`,
        },
        { id: 'invoicing', label: 'Invoicing', icon: Receipt, to: `${base}/settings/invoicing` },
        { id: 'invoice-template', label: 'Invoice template', icon: FileText, to: `${base}/settings/invoice-template` },
        { id: 'payment-terms', label: 'Payment terms', icon: FileStack, to: `${base}/settings/payment-terms` },
      ]}
    />
  );
}
