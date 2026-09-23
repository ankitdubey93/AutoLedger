import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Package, ArrowRightLeft, MapPin, Tags, Search, Settings, Hash } from 'lucide-react';
import { useAppBasePath } from '../../apps/useAppBasePath';

/**
 * StockLedger's own navigation, mirroring ForecasterSidebar/UniteconSidebar's
 * `{to, label, icon, end}` + `NavLink` idiom.
 *
 * `settings` needs `end: true` — without it, `NavLink`'s default prefix
 * matching would also mark it active on `settings/codes`.
 */
const NAV_ITEMS = [
  { to: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, end: false },
  { to: 'items', label: 'Items', icon: Package, end: false },
  { to: 'movements', label: 'Movements', icon: ArrowRightLeft, end: false },
  { to: 'locations', label: 'Locations', icon: MapPin, end: false },
  { to: 'labels', label: 'Labels', icon: Tags, end: false },
  { to: 'lookup', label: 'Lookup', icon: Search, end: false },
  { to: 'settings', label: 'Catalogue', icon: Settings, end: true },
  { to: 'settings/codes', label: 'Item codes', icon: Hash, end: false },
] as const;

export default function StockSidebar() {
  const base = useAppBasePath();
  return (
    <nav
      aria-label="StockLedger"
      className="no-print md:w-60 md:shrink-0 md:sticky md:top-14 md:h-[calc(100vh-3.5rem)] md:overflow-y-auto border-b md:border-b-0 md:border-r border-[var(--border)] md:pr-3 md:py-5"
    >
      <div className="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible pb-2 md:pb-0">
        {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={label}
            to={`${base}/${to}`}
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
    </nav>
  );
}
