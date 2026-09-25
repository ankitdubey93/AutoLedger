import { Layers, LogOut, Menu as MenuIcon, Monitor, Moon, Search, Sun, UserCog } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth, useAuthActions } from '../../context/AuthContext';
import { useOrg } from '../../context/OrgContext';
import { useTheme, type Theme } from '../../context/ThemeContext';
import { useShell } from './ShellContext';
import OrgSwitcher from './OrgSwitcher';
import Menu from '../ui/Menu';
import { initials } from '../../utils/initials';

const THEME_OPTIONS: Array<{ id: Theme; label: string; icon: typeof Sun }> = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
];

/**
 * The product's top bar. Left to right: the mobile sidebar toggle, the brand
 * mark, a search trigger for the command palette, a theme toggle, the org
 * switcher, and a user menu. Phase 33 removed the app switcher: there is one
 * product, so there is nothing to switch between.
 */
export default function AppTopBar() {
  const auth = useAuth();
  const { logout } = useAuthActions();
  const { organization } = useOrg();
  const { resolvedTheme, setTheme } = useTheme();
  const { setMobileOpen, openPalette } = useShell();

  const email = auth.status === 'authenticated' ? auth.user.email : '';
  const name = auth.status === 'authenticated' ? auth.user.name : null;
  const ThemeIcon = resolvedTheme === 'light' ? Sun : Moon;

  return (
    <header className="app-topbar no-print sticky top-0 z-30 h-14 flex items-center gap-2 px-3 md:px-4 border-b border-[var(--border)] bg-[var(--panel)]">
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        aria-label="Open menu"
        className="md:hidden p-1.5 -ml-1 rounded-md text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--panel-2)]"
      >
        <MenuIcon size={19} aria-hidden="true" />
      </button>

      <Link
        to="/"
        title="Dashboard"
        className="flex items-center gap-1.5 shrink-0 no-underline text-[var(--text)]"
      >
        <span className="flex size-6 items-center justify-center rounded-md bg-gradient-to-br from-[var(--accent)] to-[var(--accent-hover)] text-white">
          <Layers size={13} aria-hidden="true" />
        </span>
        <span className="hidden sm:inline text-sm font-semibold tracking-wide">AutoLedger</span>
      </Link>


      <button
        type="button"
        onClick={openPalette}
        className="hidden md:flex items-center gap-2 ml-2 px-3 py-1.5 rounded-md border border-[var(--border)] text-sm text-[var(--muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)] transition-colors"
      >
        <Search size={14} aria-hidden="true" />
        <span>Search or jump to…</span>
        <kbd className="ml-2 text-[10px] border border-[var(--border)] rounded px-1 py-0.5">⌘K</kbd>
      </button>
      <button
        type="button"
        onClick={openPalette}
        aria-label="Search"
        className="md:hidden p-1.5 rounded-md text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--panel-2)]"
      >
        <Search size={17} aria-hidden="true" />
      </button>

      <div className="ml-auto flex items-center gap-1.5">
        <Menu
          panelLabel="Theme"
          align="right"
          items={THEME_OPTIONS.map((option) => ({
            label: option.label,
            icon: option.icon,
            onSelect: () => setTheme(option.id),
          }))}
          trigger={({ buttonProps }) => (
            <button
              {...buttonProps}
              type="button"
              aria-label="Change theme"
              className="p-1.5 rounded-md text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--panel-2)] transition-colors"
            >
              <ThemeIcon size={16} aria-hidden="true" />
            </button>
          )}
        />

        <OrgSwitcher />

        <Menu
          panelLabel="Account"
          align="right"
          items={[
            { label: 'Account', icon: UserCog, to: '/account' },
            { type: 'separator' as const },
            { label: 'Sign out', icon: LogOut, onSelect: () => void logout(), danger: true },
          ]}
          trigger={({ buttonProps }) => (
            <button
              {...buttonProps}
              type="button"
              className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-md hover:bg-[var(--panel-2)] transition-colors"
            >
              <span className="flex size-7 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)] text-xs font-semibold">
                {initials(name, email)}
              </span>
              <span className="hidden lg:flex flex-col items-start leading-tight">
                <span className="text-xs font-medium truncate max-w-[10rem]">{email}</span>
                {organization !== null && (
                  <span className="text-[11px] text-[var(--muted)] truncate max-w-[10rem]">{organization.name}</span>
                )}
              </span>
            </button>
          )}
        />
      </div>
    </header>
  );
}
