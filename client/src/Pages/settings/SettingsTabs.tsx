import {
  Building2,
  FileStack,
  FileText,
  GitCompareArrows,
  Landmark,
  ListTree,
  Receipt,
} from 'lucide-react';
import TabBar from '../../components/ui/TabBar';

/** The tab strip shared by GeneralSettingsPage, InvoiceSettingsPage and PaymentTermsSettingsPage — a thin wrapper over the shared TabBar (Phase 31). */
export default function SettingsTabs() {

  return (
    <TabBar
      ariaLabel="Settings"
      variant="links"
      items={[
        { id: 'organization', label: 'Organization', icon: Building2, to: '/settings/general', end: true },
        { id: 'financial', label: 'Financial', icon: Landmark, to: '/settings/financial' },
        { id: 'chart', label: 'Chart of accounts', icon: ListTree, to: '/settings/chart' },
        {
          id: 'conversion-balances',
          label: 'Conversion balances',
          icon: GitCompareArrows,
          to: '/settings/conversion-balances',
        },
        { id: 'invoicing', label: 'Invoicing', icon: Receipt, to: '/settings/invoicing' },
        { id: 'invoice-template', label: 'Invoice template', icon: FileText, to: '/settings/invoice-template' },
        { id: 'payment-terms', label: 'Payment terms', icon: FileStack, to: '/settings/payment-terms' },
      ]}
    />
  );
}
