import { Link } from 'react-router-dom';
import { Boxes, Building2, History, Inbox, Landmark, Plug, Receipt, Settings as SettingsIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader';

interface SettingsLink {
  to: string;
  label: string;
}

interface SettingsSection {
  title: string;
  description: string;
  icon: LucideIcon;
  links: readonly SettingsLink[];
}

/**
 * Every setting in the product, grouped the way a bookkeeper looks for them
 * (Phase 33). Before, settings were spread across three apps: LedgerCore's
 * tabs, StockLedger's catalogue pages and AP-Flow's auto-post page. They
 * still live on their own pages; this is the one place that lists them all.
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    title: 'Organization',
    description: 'Name, address, logo, tax numbers and members.',
    icon: Building2,
    links: [
      { to: '/settings/general', label: 'General' },
      { to: '/account', label: 'Profile & members' },
    ],
  },
  {
    title: 'Accounting',
    description: 'Fiscal year, default accounts, chart of accounts and opening balances.',
    icon: Landmark,
    links: [
      { to: '/settings/financial', label: 'Financial' },
      { to: '/settings/chart', label: 'Chart of accounts' },
      { to: '/settings/conversion-balances', label: 'Conversion balances' },
      { to: '/fiscal-periods', label: 'Fiscal periods' },
    ],
  },
  {
    title: 'Sales',
    description: 'Invoice numbering, the invoice template and payment terms.',
    icon: Receipt,
    links: [
      { to: '/settings/invoicing', label: 'Invoicing' },
      { to: '/settings/invoice-template', label: 'Invoice template' },
      { to: '/settings/payment-terms', label: 'Payment terms' },
    ],
  },
  {
    title: 'Inventory',
    description: 'Industry template, categories, units, attributes and item codes.',
    icon: Boxes,
    links: [
      { to: '/inventory/setup', label: 'Industry template' },
      { to: '/settings/inventory', label: 'Catalogue' },
      { to: '/settings/inventory/codes', label: 'Item codes' },
    ],
  },
  {
    title: 'Bill inbox',
    description: 'Automatic posting of captured bills, and AI usage and cost.',
    icon: Inbox,
    links: [
      { to: '/settings/inbox', label: 'Auto-post' },
      { to: '/settings/ai-usage', label: 'AI usage' },
    ],
  },
  {
    title: 'Connections',
    description: 'Google Drive folders and outbound webhooks.',
    icon: Plug,
    links: [
      { to: '/settings/connections', label: 'Google Drive' },
      { to: '/settings/webhooks', label: 'Webhooks' },
      { to: '/settings/webhooks/deliveries', label: 'Webhook deliveries' },
    ],
  },
  {
    title: 'Audit',
    description: 'Every change to financial data, who made it and when.',
    icon: History,
    links: [{ to: '/settings/audit', label: 'Audit trail' }],
  },
];

export default function SettingsHubPage() {
  return (
    <section className="flex flex-col gap-6">
      <PageHeader icon={SettingsIcon} title="Settings" subtitle="Everything that configures how AutoLedger works for this organization." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {SETTINGS_SECTIONS.map((section) => {
          const Icon = section.icon;
          return (
            <section key={section.title} className="card flex flex-col gap-3" aria-labelledby={`settings-${section.title}`}>
              <header className="flex items-center gap-2.5">
                <span
                  aria-hidden="true"
                  className="flex size-8 items-center justify-center rounded-md bg-[var(--accent-soft)] text-[var(--accent)]"
                >
                  <Icon size={16} />
                </span>
                <h2 id={`settings-${section.title}`} className="text-base font-semibold m-0">
                  {section.title}
                </h2>
              </header>
              <p className="muted m-0">{section.description}</p>
              <ul className="flex flex-col gap-1.5 m-0 p-0 list-none">
                {section.links.map((link) => (
                  <li key={link.to}>
                    <Link to={link.to}>{link.label}</Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </section>
  );
}
