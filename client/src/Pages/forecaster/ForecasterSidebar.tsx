import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Plus } from 'lucide-react';
import { useAppBasePath } from '../../apps/useAppBasePath';

/**
 * ForecasterPro's own navigation — one group, mirroring FpaSidebar's
 * `{to, label, icon, end}` + `NavLink` idiom. No onboarding-gated items:
 * Phase 13 has no setup wizard.
 *
 * `to` is a suffix, not a target — every link is built as an absolute
 * `${base}/${to}` from `useAppBasePath()`, the same reason FpaSidebar's own
 * header comment records.
 */
const NAV_GROUPS = [
  {
    heading: 'Plans',
    items: [
      { to: '', label: 'All plans', icon: LayoutDashboard, end: true },
      { to: 'new', label: 'New plan', icon: Plus, end: false },
    ],
  },
] as const;

export default function ForecasterSidebar() {
  const base = useAppBasePath();
  return (
    <nav
      aria-label="ForecasterPro"
      className="no-print md:w-60 md:shrink-0 md:sticky md:top-14 md:h-[calc(100vh-3.5rem)] md:overflow-y-auto border-b md:border-b-0 md:border-r border-[var(--border)] md:pr-3 md:py-5"
    >
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
