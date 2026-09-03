import { NavLink } from 'react-router-dom';
import {
  BookOpen,
  FileBarChart,
  LayoutDashboard,
  ListTree,
  Scale,
  Settings as SettingsIcon,
} from 'lucide-react';

/**
 * LedgerCore's own navigation — the sidebar that replaces the Phase 3 tab
 * strip. Extends the same `{to, label, icon, end}` + `NavLink` idiom
 * LedgerCoreRoutes.tsx used before this change; only the layout is new.
 *
 * Relative `to` values, same reason as before: this renders inside the
 * platform's `/app/:appSlug` splat route, so a bare `'accounts'` resolves
 * against the current app, never a hardcoded `/app/ledger-core/accounts`.
 */
const NAV = [
  { to: '', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: 'accounts', label: 'Chart of Accounts', icon: ListTree, end: false },
  { to: 'journals', label: 'Journal Entries', icon: BookOpen, end: false },
  { to: 'trial-balance', label: 'Trial Balance', icon: Scale, end: false },
  { to: 'reports', label: 'Reports', icon: FileBarChart, end: false },
  { to: 'settings', label: 'Settings', icon: SettingsIcon, end: false },
] as const;

export default function LedgerCoreSidebar() {
  return (
    <nav className="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible border-b md:border-b-0 md:border-r border-[var(--border)] pb-2 md:pb-0 md:pr-4">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={label}
          to={to}
          end={end}
          className={({ isActive }) =>
            [
              'flex items-center gap-2 px-3 py-2 text-sm no-underline rounded-md whitespace-nowrap transition-colors',
              isActive
                ? 'bg-[var(--panel)] text-[var(--text)] font-medium'
                : 'text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--panel)]',
            ].join(' ')
          }
        >
          <Icon size={16} aria-hidden="true" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
