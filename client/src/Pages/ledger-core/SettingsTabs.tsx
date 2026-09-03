import { NavLink } from 'react-router-dom';
import { useAppBasePath } from '../../apps/useAppBasePath';

/** The two-tab strip shared by SettingsPage and InvoiceSettingsPage. */
export default function SettingsTabs() {
  const base = useAppBasePath();

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    [
      'px-3 py-1.5 text-sm no-underline rounded-md',
      isActive
        ? 'bg-[var(--panel)] text-[var(--text)] font-medium'
        : 'text-[var(--muted)] hover:text-[var(--text)]',
    ].join(' ');

  return (
    <nav aria-label="Settings" className="flex gap-1 border-b border-[var(--border)] pb-2">
      <NavLink to={`${base}/settings`} end className={linkClass}>
        Organization
      </NavLink>
      <NavLink to={`${base}/settings/invoicing`} className={linkClass}>
        Invoicing
      </NavLink>
    </nav>
  );
}
