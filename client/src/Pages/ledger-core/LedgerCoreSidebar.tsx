import { NavLink } from 'react-router-dom';
import {
  Banknote,
  BookOpen,
  Building2,
  CalendarCheck,
  FileBarChart,
  FileText,
  History,
  LayoutDashboard,
  ListTree,
  ReceiptText,
  Scale,
  Settings as SettingsIcon,
  Users,
} from 'lucide-react';
import { useAppBasePath } from '../../apps/useAppBasePath';
import CreateMenu from './CreateMenu';

/**
 * LedgerCore's own navigation — a grouped, sticky, full-height rail.
 * Extends the same `{to, label, icon, end}` + `NavLink` idiom the original
 * flat tab strip used; only the layout and grouping are new.
 *
 * Each item's `to` is a suffix, not a target: every link is built as an
 * absolute `${base}/${to}` from `useAppBasePath()`. Relative targets do not
 * work here — this sidebar renders inside a descendant `<Routes>` under the
 * platform's `/app/:appSlug` splat, and react-router resolves a relative
 * `to` against that splat match's full pathname, so `'journals'` clicked
 * from `/app/ledger-core/accounts` resolves to
 * `/app/ledger-core/accounts/journals`.
 *
 * `md:top-14` and `calc(100vh-3.5rem)` both encode AppTopBar's `h-14`
 * (3.5rem). If that height ever changes, both must change with it.
 */
const NAV_GROUPS = [
  {
    heading: 'Overview',
    items: [{ to: '', label: 'Dashboard', icon: LayoutDashboard, end: true }],
  },
  {
    heading: 'Bookkeeping',
    items: [
      { to: 'accounts', label: 'Chart of Accounts', icon: ListTree, end: false },
      { to: 'journals', label: 'Journal Entries', icon: BookOpen, end: false },
    ],
  },
  {
    heading: 'Sales',
    items: [
      { to: 'invoices', label: 'Invoices', icon: FileText, end: false },
      { to: 'customers', label: 'Customers', icon: Users, end: false },
      { to: 'payments', label: 'Payments', icon: Banknote, end: false },
    ],
  },
  {
    heading: 'Purchases',
    items: [
      { to: 'bills', label: 'Bills', icon: ReceiptText, end: false },
      { to: 'vendors', label: 'Vendors', icon: Building2, end: false },
    ],
  },
  {
    heading: 'Reporting',
    items: [
      { to: 'trial-balance', label: 'Trial Balance', icon: Scale, end: false },
      { to: 'reports', label: 'Reports', icon: FileBarChart, end: false },
    ],
  },
  {
    heading: 'Configure',
    items: [
      { to: 'fiscal-periods', label: 'Fiscal Periods', icon: CalendarCheck, end: false },
      { to: 'settings', label: 'Settings', icon: SettingsIcon, end: false },
      { to: 'audit', label: 'Audit Trail', icon: History, end: false },
    ],
  },
] as const;

export default function LedgerCoreSidebar() {
  const base = useAppBasePath();
  return (
    <nav
      aria-label="LedgerCore"
      className="no-print md:w-60 md:shrink-0 md:sticky md:top-14 md:h-[calc(100vh-3.5rem)] md:overflow-y-auto border-b md:border-b-0 md:border-r border-[var(--border)] md:pr-3 md:py-5"
    >
      <div className="hidden md:block mb-4 px-1">
        <CreateMenu />
      </div>
      <div className="flex md:flex-col gap-1 md:gap-6 overflow-x-auto md:overflow-visible pb-2 md:pb-0">
        {NAV_GROUPS.map((group) => (
          <div key={group.heading} className="flex md:flex-col gap-1">
            <p className="hidden md:block px-3 mb-1 mt-0 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--muted)]">
              {group.heading}
            </p>
            {group.items.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={label}
                to={to === '' ? base : `${base}/${to}`}
                end={end}
                className={({ isActive }) =>
                  [
                    'flex items-center gap-2.5 px-3 py-2 text-sm no-underline rounded-md whitespace-nowrap transition-colors',
                    isActive
                      ? 'bg-[var(--panel)] text-[var(--text)] font-medium shadow-[inset_2px_0_0_var(--good)]'
                      : 'text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--panel)]',
                  ].join(' ')
                }
              >
                <Icon size={16} aria-hidden="true" />
                {label}
              </NavLink>
            ))}
          </div>
        ))}
      </div>
    </nav>
  );
}
