import { NavLink } from 'react-router-dom';
import { BookOpen, MessageCircleQuestion } from 'lucide-react';
import { useAppBasePath } from '../../apps/useAppBasePath';

/** TaxGuard's own navigation, mirroring BoardDeckSidebar's `{to, label, icon, end}` + `NavLink` idiom. */
const NAV_ITEMS = [
  { to: 'corpus', label: 'Corpus', icon: BookOpen, end: false },
  { to: 'ask', label: 'Ask', icon: MessageCircleQuestion, end: false },
] as const;

export default function TaxGuardSidebar() {
  const base = useAppBasePath();
  return (
    <nav
      aria-label="TaxGuard AI"
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
